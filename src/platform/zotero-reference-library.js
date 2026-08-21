import {
    normalizeArxivID,
    normalizeDOI,
} from '../citations/citation-identifiers.js';

const MAX_ITEMS = 50_000;
const MAX_ATTACHMENTS = 1_000;
const MAX_TITLE_LENGTH = 512;
const MAX_KEY_LENGTH = 128;
const MAX_FIELD_LENGTH = 4_096;
const MAX_EXTRA_LENGTH = 16 * 1_024;
const MAX_PDF_URL_LENGTH = 2_048;
const MAX_CANDIDATES = 20;

export function createZoteroReferenceLibrary(zotero, options = {}) {
    return new ZoteroReferenceLibrary(zotero, options);
}

export class ZoteroReferenceLibrary {
    constructor(zotero, {
        loadItems = null,
        searchFactory = null,
        translateFactory = null,
        importPDF = null,
    } = {}) {
        if (!zotero || typeof zotero !== 'object') {
            throw new TypeError('A Zotero runtime is required');
        }
        this.zotero = zotero;
        this.loadItems = loadItems;
        this.searchFactory = searchFactory;
        this.translateFactory = translateFactory;
        this.importPDF = importPDF;
        this.index = null;
        this.refreshPromise = null;
        this.invalidated = true;
    }

    async listLibraries({ signal } = {}) {
        throwIfAborted(signal);
        return discoverLibraries(this.zotero);
    }

    async getDefaultLibraryID(sourceItemID, { signal } = {}) {
        const libraries = await this.listLibraries({ signal });
        const personal = libraries.find(library => library.type === 'user');
        const source = await this.#getItem(sourceItemID);
        throwIfAborted(signal);
        const sourceLibraryID = source?.libraryID;
        const sourceLibrary = libraries.find(library => (
            String(library.libraryID) === String(sourceLibraryID)
        ));
        if (sourceLibrary?.editable) return sourceLibrary.libraryID;
        return personal?.libraryID ?? libraries[0]?.libraryID ?? null;
    }

    invalidate() {
        this.invalidated = true;
    }

    async refreshIndex({ signal } = {}) {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.#buildIndex(signal)
            .finally(() => {
                this.refreshPromise = null;
            });
        return this.refreshPromise;
    }

    async find(reference, { targetLibraryID = null, signal } = {}) {
        await this.#ensureIndex(signal);
        throwIfAborted(signal);
        const identifiers = normalizeReferenceIdentifiers(reference);
        const matches = uniqueMatches(
            identifierMatches(this.index, identifiers)
        );
        const selectedMatches = targetLibraryID === null
            || targetLibraryID === undefined
            ? matches
            : matches.filter(match => (
                String(match.libraryID) === String(targetLibraryID)
            ));
        const otherMatches = targetLibraryID === null
            || targetLibraryID === undefined
            ? []
            : matches.filter(match => (
                String(match.libraryID) !== String(targetLibraryID)
            ));
        return {
            identifiers,
            selectedMatches,
            otherMatches,
            candidates: titleCandidates(this.index, reference, targetLibraryID),
        };
    }

    async lookupByIdentifier(identifier) {
        await this.#ensureIndex();
        const normalized = normalizeIdentifier(identifier);
        if (!normalized.value) return [];
        return uniqueMatches(
            this.index.byIdentifier.get(identifierKey(normalized)) || []
        );
    }

    async openItem(itemID) {
        const item = await this.#getItem(itemID);
        if (!item?.isRegularItem?.()) {
            throw referenceError(
                'REFERENCE_ITEM_UNAVAILABLE',
                'The Zotero reference is unavailable'
            );
        }
        const pane = this.zotero.getMainWindow?.()?.ZoteroPane;
        if (typeof pane?.selectItem !== 'function') {
            throw referenceError(
                'REFERENCE_ITEM_PANE_UNAVAILABLE',
                'The Zotero item pane is unavailable'
            );
        }
        await pane.selectItem(item.id);
        return item.id;
    }

    async copyItem({ itemID, targetLibraryID } = {}) {
        const libraries = await this.listLibraries();
        const library = libraries.find(candidate => (
            String(candidate.libraryID) === String(targetLibraryID)
        ));
        if (!library?.editable) {
            throw referenceError(
                'REFERENCE_LIBRARY_READ_ONLY',
                'The selected Zotero library is read-only'
            );
        }
        const source = await this.#getItem(itemID);
        if (!source?.isRegularItem?.() || typeof source.clone !== 'function') {
            throw referenceError(
                'REFERENCE_COPY_UNAVAILABLE',
                'Zotero cannot copy this reference into the selected library'
            );
        }
        if (String(source.libraryID) === String(library.libraryID)) {
            return { itemID: source.id, hasPDF: await hasPDFAttachment(
                this.zotero,
                safeAttachmentIDs(source)
            ) };
        }
        const clone = source.clone(library.libraryID);
        const save = clone.saveTx || clone.save;
        if (typeof save !== 'function') {
            throw referenceError(
                'REFERENCE_COPY_UNAVAILABLE',
                'Zotero cannot copy this reference into the selected library'
            );
        }
        const copiedID = await save.call(clone, { skipSelect: true });
        const newItemID = copiedID ?? clone.id;
        if (newItemID === null || newItemID === undefined) {
            throw referenceError(
                'REFERENCE_COPY_UNAVAILABLE',
                'Zotero did not return the copied reference'
            );
        }
        let hasPDF = false;
        if (library.filesEditable
            && typeof this.zotero.Attachments?.copyAttachmentToLibrary
                === 'function') {
            const copyPDFs = async () => {
                for (const attachmentID of safeAttachmentIDs(source)) {
                    const attachment = await this.#getItem(attachmentID);
                    if (!attachment?.isPDFAttachment?.()) continue;
                    try {
                        await this.zotero.Attachments.copyAttachmentToLibrary(
                            attachment,
                            library.libraryID,
                            newItemID
                        );
                        hasPDF = true;
                    }
                    catch {
                        // Keep the successfully copied metadata item. The
                        // import service can still resolve and retry a PDF.
                    }
                }
            };
            if (typeof this.zotero.DB?.executeTransaction === 'function') {
                await this.zotero.DB.executeTransaction(copyPDFs);
            }
            else {
                await copyPDFs();
            }
        }
        try {
            await clone.addLinkedItem?.(source);
        }
        catch {
            // A cross-library linked-item relation is useful but optional.
        }
        this.invalidate();
        return { itemID: newItemID, hasPDF };
    }

    async translateIdentifier({ reference, libraryID, signal } = {}) {
        throwIfAborted(signal);
        const libraries = await this.listLibraries();
        const library = libraries.find(candidate => (
            String(candidate.libraryID) === String(libraryID)
        ));
        if (!library?.editable) {
            throw referenceError(
                'REFERENCE_LIBRARY_READ_ONLY',
                'The selected Zotero library is read-only'
            );
        }
        const identifiers = normalizeReferenceIdentifiers(reference);
        const identifier = firstIdentifier(identifiers);
        if (!identifier.value) {
            throw referenceError(
                'REFERENCE_IDENTIFIER_UNSUPPORTED',
                'The reference has no supported identifier'
            );
        }
        const translator = this.#createTranslator();
        if (!translator) {
            throw referenceError(
                'REFERENCE_TRANSLATOR_UNAVAILABLE',
                'Zotero identifier lookup is unavailable'
            );
        }
        throwIfAborted(signal);
        setTranslatorIdentifier(translator, identifier);
        try {
            translator.libraryID = library.libraryID;
            translator.saveAttachments = true;
        }
        catch {
            // Older Zotero translators expose these as translate options only.
        }
        const translators = await translator.getTranslators?.();
        if (Array.isArray(translators) && !translators.length) {
            throw referenceError(
                'REFERENCE_TRANSLATOR_NOT_FOUND',
                'Zotero could not find a translator for this identifier'
            );
        }
        if (Array.isArray(translators) && translators[0]) {
            translator.setTranslator?.(translators[0]);
        }
        throwIfAborted(signal);
        const result = await translator.translate?.({
            libraryID: library.libraryID,
            saveAttachments: true,
        });
        throwIfAborted(signal);
        const items = Array.isArray(result) ? result : result?.items;
        if (!Array.isArray(items) || !items.length) {
            throw referenceError(
                'REFERENCE_TRANSLATOR_EMPTY',
                'Zotero did not return bibliographic metadata'
            );
        }
        return {
            items: items.slice(0, 100),
            attachments: [
                ...(await collectTranslatedAttachments(this.zotero, items)),
                ...(Array.isArray(result?.attachments)
                    ? result.attachments.filter(isPDFAttachmentProjection)
                    : []),
            ].slice(0, MAX_ATTACHMENTS),
            identifier,
            libraryID: library.libraryID,
        };
    }

    async attachPDF({ itemID, libraryID, url, signal } = {}) {
        throwIfAborted(signal);
        const normalizedURL = normalizePDFURL(url);
        if (!normalizedURL) {
            throw referenceError(
                'REFERENCE_PDF_URL_INVALID',
                'The PDF URL is invalid'
            );
        }
        const libraries = await this.listLibraries();
        const library = libraries.find(candidate => (
            String(candidate.libraryID) === String(libraryID)
        ));
        if (!library?.editable || !library.filesEditable) {
            throw referenceError(
                'REFERENCE_FILES_READ_ONLY',
                'The selected Zotero library cannot import PDF files'
            );
        }
        const importPDF = this.importPDF
            || this.zotero.Attachments?.importFromURL;
        if (typeof importPDF !== 'function') {
            throw referenceError(
                'REFERENCE_PDF_IMPORT_UNAVAILABLE',
                'Zotero PDF import is unavailable'
            );
        }
        throwIfAborted(signal);
        const context = {
            libraryID: library.libraryID,
            contentType: 'application/pdf',
            signal,
        };
        const attachment = this.importPDF
            ? await importPDF(normalizedURL, itemID, context)
            : await callNativePDFImport(
                importPDF,
                this.zotero,
                normalizedURL,
                itemID,
                library.libraryID,
                signal
            );
        throwIfAborted(signal);
        return projectAttachment(attachment);
    }

    async #buildIndex(signal) {
        const libraries = await this.listLibraries({ signal });
        const byIdentifier = new Map();
        const byTitle = new Map();
        let itemCount = 0;
        for (const library of libraries) {
            throwIfAborted(signal);
            const items = await this.#listLibraryItems(library.libraryID, signal);
            for (const item of items.slice(0, MAX_ITEMS)) {
                throwIfAborted(signal);
                const projected = await projectItem(
                    item,
                    this.zotero,
                    library.name,
                    signal
                );
                if (!projected) continue;
                itemCount++;
                for (const identifier of itemIdentifiers(projected)) {
                    const key = identifierKey(identifier);
                    const values = byIdentifier.get(key) || [];
                    values.push(projected);
                    byIdentifier.set(key, values);
                }
                const titleKey = titleKeyFor(projected.title);
                if (titleKey) {
                    const values = byTitle.get(titleKey) || [];
                    values.push(projected);
                    byTitle.set(titleKey, values);
                }
                if (itemCount >= MAX_ITEMS) break;
            }
            if (itemCount >= MAX_ITEMS) break;
        }
        this.index = { byIdentifier, byTitle, libraries };
        this.invalidated = false;
        return this.index;
    }

    async #ensureIndex(signal) {
        if (!this.invalidated && this.index) return this.index;
        return this.refreshIndex({ signal });
    }

    async #listLibraryItems(libraryID, signal) {
        if (typeof this.loadItems === 'function') {
            return (await this.loadItems(libraryID, { signal })) || [];
        }
        const search = this.searchFactory
            ? this.searchFactory()
            : typeof this.zotero.Search === 'function'
                ? new this.zotero.Search()
                : null;
        if (search) {
            search.libraryID = libraryID;
            search.addCondition?.('itemType', 'isNot', 'attachment');
            search.addCondition?.('itemType', 'isNot', 'note');
            search.addCondition?.('itemType', 'isNot', 'annotation');
            const ids = await search.search();
            throwIfAborted(signal);
            const items = await loadItems(this.zotero, ids);
            throwIfAborted(signal);
            return items;
        }
        const items = await this.zotero.Items?.getAll?.(libraryID);
        throwIfAborted(signal);
        return Array.isArray(items) ? items : [];
    }

    async #getItem(itemID) {
        if (itemID === null || itemID === undefined) return null;
        try {
            return await this.zotero.Items?.getAsync?.(itemID);
        }
        catch {
            return null;
        }
    }

    #createTranslator() {
        if (typeof this.translateFactory === 'function') {
            return this.translateFactory();
        }
        const Search = this.zotero.Translate?.Search;
        return typeof Search === 'function' ? new Search() : null;
    }
}

export function discoverLibraries(zotero) {
    const source = typeof zotero?.Libraries?.getAll === 'function'
        ? zotero.Libraries.getAll()
        : [];
    const libraries = Array.isArray(source) ? source : [];
    const userLibraryID = zotero?.Libraries?.userLibraryID;
    const projections = libraries.map(library => projectLibrary(
        library,
        userLibraryID
    )).filter(Boolean);
    if (!projections.some(library => library.type === 'user')) {
        const user = zotero?.Libraries?.get?.(userLibraryID);
        const projection = projectLibrary(user, userLibraryID);
        if (projection) projections.unshift(projection);
    }
    return dedupeLibraries(projections);
}

function projectLibrary(library, userLibraryID) {
    if (!library) return null;
    const libraryID = library.libraryID ?? library.id;
    if (libraryID === null || libraryID === undefined) return null;
    const declaredType = String(
        library.libraryType || library.type || ''
    ).toLowerCase();
    if (declaredType === 'feed'
        || readBoolean(library, 'isFeed')
        || readBoolean(library, 'feed')) {
        return null;
    }
    const type = declaredType === 'group'
        || readBoolean(library, 'isGroup')
        || String(libraryID) !== String(userLibraryID)
            && library.groupID !== undefined
        ? 'group'
        : 'user';
    const editable = library.editable !== undefined
        ? Boolean(library.editable)
        : type === 'user';
    const filesEditable = library.filesEditable !== undefined
        ? Boolean(library.filesEditable)
        : editable;
    return {
        libraryID,
        name: boundedString(library.name || (
            type === 'user' ? 'My Library' : `Group ${libraryID}`
        ), 256),
        type,
        editable,
        filesEditable,
    };
}

function dedupeLibraries(libraries) {
    const seen = new Set();
    return libraries.filter(library => {
        const key = String(library.libraryID);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((left, right) => {
        if (left.type !== right.type) return left.type === 'user' ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

async function projectItem(item, zotero, libraryName = '', signal) {
    throwIfAborted(signal);
    if (!item?.isRegularItem?.() || isDeleted(item)) return null;
    const identifiers = normalizeItemIdentifiers(item);
    const attachments = safeAttachmentIDs(item);
    const hasPDF = await hasPDFAttachment(zotero, attachments, signal);
    return {
        itemID: item.id,
        libraryID: item.libraryID,
        libraryName: boundedString(libraryName, 256),
        key: boundedString(item.key, MAX_KEY_LENGTH),
        title: boundedString(safeField(item, 'title'), MAX_TITLE_LENGTH),
        year: itemYear(item),
        authorSearchText: itemAuthorSearchText(item),
        hasPDF,
        identifiers,
    };
}

function normalizeItemIdentifiers(item) {
    const doi = normalizeDOI(safeField(item, 'DOI'));
    const arxivID = normalizeArxivID(
        safeField(item, 'extra').match(/(?:^|\n)\s*arxiv(?:\s+id)?\s*:\s*([^\n]+)/iu)?.[1]
            || ''
    );
    const pmid = normalizePMID(
        safeField(item, 'PMID')
            || safeField(item, 'extra').match(/(?:^|\n)\s*(?:PMID|PubMed ID)\s*:\s*(\d{1,12})/iu)?.[1]
            || ''
    );
    return { doi, arxivID, pmid };
}

function normalizeReferenceIdentifiers(reference) {
    return {
        doi: normalizeDOI(reference?.identifiers?.doi || reference?.doi),
        arxivID: normalizeArxivID(
            reference?.identifiers?.arxivID || reference?.arxivID
        ),
        pmid: normalizePMID(reference?.identifiers?.pmid || reference?.pmid),
        pdfURL: normalizePDFURL(
            reference?.identifiers?.pdfURL || reference?.pdfURL
        ),
    };
}

function firstIdentifier(identifiers) {
    for (const type of ['doi', 'arxivID', 'pmid']) {
        if (identifiers[type]) return { type, value: identifiers[type] };
    }
    return { type: '', value: '' };
}

function itemIdentifiers(projected) {
    return ['doi', 'arxivID', 'pmid'].flatMap(type => (
        projected.identifiers[type]
            ? [{ type, value: projected.identifiers[type] }]
            : []
    ));
}

function identifierMatches(index, identifiers) {
    for (const type of ['doi', 'arxivID', 'pmid']) {
        if (!identifiers[type]) continue;
        const matches = index.byIdentifier.get(
            identifierKey({ type, value: identifiers[type] })
        );
        if (matches?.length) return matches;
    }
    return [];
}

function titleCandidates(index, reference, targetLibraryID) {
    const referenceText = titleKeyFor(reference?.text);
    if (!referenceText) return [];
    const referenceYear = Number.parseInt(reference?.year, 10) || 0;
    const referenceAuthors = new Set(
        titleKeyFor(reference?.authorSearchText).split(' ').filter(Boolean)
    );
    const candidates = [];
    for (const [title, matches] of index.byTitle) {
        if (title.length < 8
            || !(` ${referenceText} `.includes(` ${title} `))) continue;
        for (const match of matches) {
            if (referenceYear && match.year && referenceYear !== match.year) {
                continue;
            }
            if (referenceAuthors.size && match.authorSearchText
                && !titleKeyFor(match.authorSearchText).split(' ')
                    .some(author => referenceAuthors.has(author))) continue;
            candidates.push(match);
            if (candidates.length >= MAX_CANDIDATES) break;
        }
        if (candidates.length >= MAX_CANDIDATES) break;
    }
    return uniqueMatches(candidates.filter(match => (
        targetLibraryID === null
        || targetLibraryID === undefined
        || String(match.libraryID) === String(targetLibraryID)
    )));
}

function uniqueMatches(matches) {
    return [...new Map((matches || []).map(match => [
        `${match.libraryID}:${match.itemID}`,
        { ...match, identifiers: undefined, authorSearchText: undefined },
    ])).values()].map(match => {
        const { identifiers, authorSearchText, ...publicMatch } = match;
        return publicMatch;
    });
}

function identifierKey(identifier) {
    return `${identifier.type}:${identifier.value}`;
}

function titleKeyFor(value) {
    return boundedString(value, MAX_TITLE_LENGTH)
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

async function hasPDFAttachment(zotero, attachmentIDs, signal) {
    for (const attachmentID of attachmentIDs.slice(0, MAX_ATTACHMENTS)) {
        throwIfAborted(signal);
        try {
            const attachment = await zotero.Items?.getAsync?.(attachmentID);
            if (attachment?.isPDFAttachment?.()
                || safeField(attachment, 'contentType').toLowerCase()
                    === 'application/pdf'
                || /\.pdf$/iu.test(safeField(attachment, 'path'))) {
                return true;
            }
        }
        catch {
            // A missing attachment should not hide a bibliographic item.
        }
    }
    return false;
}

function safeAttachmentIDs(item) {
    try {
        const values = item.getAttachments?.();
        return Array.isArray(values) ? values.slice(0, MAX_ATTACHMENTS) : [];
    }
    catch {
        return [];
    }
}

async function collectTranslatedAttachments(zotero, items) {
    const attachments = [];
    for (const item of items) {
        for (const id of safeAttachmentIDs(item)) {
            if (!await hasPDFAttachment(zotero, [id])) continue;
            attachments.push({ id, parentItemID: item?.id });
        }
    }
    return attachments;
}

function isPDFAttachmentProjection(value) {
    if (!value || typeof value !== 'object') return false;
    const contentType = boundedString(value.contentType, 128).toLowerCase();
    const path = boundedString(value.path, MAX_FIELD_LENGTH);
    return contentType === 'application/pdf' || /\.pdf$/iu.test(path);
}

function projectAttachment(attachment) {
    if (!attachment) return null;
    return {
        itemID: attachment.id ?? attachment.itemID ?? null,
        libraryID: attachment.libraryID ?? null,
    };
}

async function callNativePDFImport(importPDF, zotero, url, itemID, libraryID, signal) {
    // Zotero 7–9 expose the options-object form. With application/pdf,
    // importFromURL downloads through Zotero's attachment pipeline and
    // rejects files whose sniffed type is not supported. The signal is
    // enforced before and after the accepted download because native import
    // does not expose a stable cancellation parameter across these versions.
    void signal;
    return importPDF.call(zotero.Attachments, {
        url,
        parentItemID: itemID,
        libraryID,
        contentType: 'application/pdf',
        fileBaseName: 'reference.pdf',
    });
}

function setTranslatorIdentifier(translator, identifier) {
    if (typeof translator.setIdentifier !== 'function') {
        throw referenceError(
            'REFERENCE_TRANSLATOR_UNAVAILABLE',
            'Zotero identifier lookup is unavailable'
        );
    }
    const field = identifier.type === 'arxivID' ? 'arXiv' : (
        identifier.type === 'pmid' ? 'PMID' : 'DOI'
    );
    translator.setIdentifier({ [field]: identifier.value });
}

function normalizeIdentifier(identifier) {
    const type = String(identifier?.type || '');
    const value = type === 'doi'
        ? normalizeDOI(identifier.value)
        : type === 'arxivID'
            ? normalizeArxivID(identifier.value)
            : type === 'pmid'
                ? normalizePMID(identifier.value)
                : '';
    return { type, value };
}

function normalizePDFURL(value) {
    if (typeof value !== 'string' || value.length > MAX_PDF_URL_LENGTH) {
        return '';
    }
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        if (url.username || url.password || !isPublicHost(url.hostname)) return '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return '';
    }
}

function isPublicHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.endsWith('.internal')
        || host.endsWith('.home.arpa')) return false;
    const octets = host.split('.').map(value => Number(value));
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value)
        || value < 0 || value > 255)) {
        return !host.includes(':') || !isPrivateIPv6(host);
    }
    const [first, second] = octets;
    return first !== 0 && first !== 10 && first !== 127
        && !(first === 100 && second >= 64 && second <= 127)
        && !(first === 169 && second === 254)
        && !(first === 172 && second >= 16 && second <= 31)
        && !(first === 192 && second === 168);
}

function isPrivateIPv6(host) {
    return host === '::1' || host === '::'
        || /^(?:fc|fd|fe8|fe9|fea|feb)/iu.test(host)
        || /^::ffff:(?:0:)?(?:127\.|10\.|192\.168\.)/iu.test(host);
}

function normalizePMID(value) {
    const normalized = boundedString(value, MAX_FIELD_LENGTH).trim();
    return /^\d{1,12}$/.test(normalized) ? normalized : '';
}

function itemYear(item) {
    const year = Number(safeField(item, 'year'));
    if (Number.isSafeInteger(year) && year >= 0 && year <= 9_999) return year;
    const match = /(?:^|\D)((?:18|19|20)\d{2})(?:\D|$)/u
        .exec(safeField(item, 'date'));
    return match ? Number(match[1]) : 0;
}

function itemAuthorSearchText(item) {
    try {
        const creators = item.getCreators?.();
        if (!Array.isArray(creators)) return '';
        return boundedString(creators.slice(0, 100).map(creator => (
            creator?.lastName || creator?.name || ''
        )).filter(Boolean).join(' '), MAX_FIELD_LENGTH).toLocaleLowerCase();
    }
    catch {
        return '';
    }
}

function safeField(item, field) {
    try {
        return boundedString(item?.getField?.(field), field === 'extra'
            ? MAX_EXTRA_LENGTH
            : MAX_FIELD_LENGTH);
    }
    catch {
        return '';
    }
}

function isDeleted(item) {
    try {
        const inTrash = typeof item.inTrash === 'function'
            ? item.inTrash()
            : item.inTrash;
        return Boolean(item.deleted || inTrash);
    }
    catch {
        return true;
    }
}

async function loadItems(zotero, itemIDs) {
    if (!Array.isArray(itemIDs) || !itemIDs.length) return [];
    const loaded = await zotero.Items?.getAsync?.(itemIDs);
    if (Array.isArray(loaded)) return loaded.filter(Boolean);
    return Promise.all(itemIDs.slice(0, MAX_ITEMS).map(id => (
        zotero.Items?.getAsync?.(id)
    ))).then(items => items.filter(Boolean));
}

function readBoolean(value, property) {
    try {
        return typeof value[property] === 'function'
            ? Boolean(value[property]())
            : Boolean(value[property]);
    }
    catch {
        return false;
    }
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum).trim() : '';
}

function referenceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = signal.reason instanceof Error
            ? signal.reason
            : new Error('The operation was aborted');
        if (!error.name) error.name = 'AbortError';
        throw error;
    }
}
