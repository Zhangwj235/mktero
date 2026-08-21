import {
    extractCitationIdentifiers,
} from '../citations/citation-identifiers.js';
import { citationPaperNodeID } from '../citations/citation-graph-builder.js';

const MAX_TITLE_LENGTH = 512;
const MAX_ATTACHMENTS = 1_000;

export function createZoteroCitationLibrary(zotero) {
    if (!zotero?.Items || typeof zotero.Search !== 'function') {
        throw new TypeError('A Zotero library runtime is required');
    }
    return {
        async listPapers(libraryID) {
            const search = new zotero.Search();
            search.libraryID = libraryID;
            search.addCondition?.('itemType', 'isNot', 'attachment');
            search.addCondition?.('itemType', 'isNot', 'note');
            search.addCondition?.('itemType', 'isNot', 'annotation');
            const itemIDs = await search.search();
            const items = await loadItems(zotero, itemIDs);
            return items.filter(item => (
                item?.isRegularItem?.()
                && !isDeleted(item)
                && String(item.libraryID) === String(libraryID)
            )).map(projectPaper).sort((left, right) => (
                left.key.localeCompare(right.key)
            ));
        },

        async resolveGraphOrigin(itemID) {
            const item = await zotero.Items.getAsync(itemID);
            const parent = await resolveBibliographicItem(zotero, item);
            if (!parent?.isRegularItem?.()) throw parentRequiredError();
            return {
                libraryID: parent.libraryID,
                itemID: parent.id,
            };
        },

        async openPaper(node) {
            const item = await zotero.Items.getAsync(node?.itemID);
            if (!item?.isRegularItem?.()) {
                throw new Error('The Zotero paper is unavailable');
            }
            const attachment = await findCitationPaperPDFAttachment(zotero, {
                ...node,
                attachmentIDs: Array.isArray(node?.attachmentIDs)
                    && node.attachmentIDs.length
                    ? node.attachmentIDs
                    : safeAttachments(item),
            });
            if (attachment) {
                if (typeof zotero.Reader?.open === 'function') {
                    await zotero.Reader.open(attachment.id);
                    return { kind: 'pdf', itemID: attachment.id };
                }
            }
            const pane = zotero.getMainWindow?.()?.ZoteroPane;
            if (typeof pane?.selectItem !== 'function') {
                throw new Error('The Zotero item pane is unavailable');
            }
            await pane.selectItem(item.id);
            return { kind: 'item', itemID: item.id };
        },
    };
}

export async function findCitationPaperPDFAttachment(zotero, paper) {
    const attachmentIDs = Array.isArray(paper?.attachmentIDs)
        ? paper.attachmentIDs
        : [];
    for (const attachmentID of attachmentIDs.slice(0, MAX_ATTACHMENTS)) {
        const attachment = await zotero?.Items?.getAsync?.(attachmentID);
        if (attachment?.isPDFAttachment?.()) return attachment;
    }
    return null;
}

function projectPaper(item) {
    const { doi, arxivID } = extractCitationIdentifiers({
        doi: safeField(item, 'DOI'),
        extra: safeField(item, 'extra'),
    });
    const paper = {
        itemID: item.id,
        key: boundedString(item.key, 128),
        libraryID: item.libraryID,
        title: paperTitle(item),
        year: paperYear(item),
        doi,
        arxivID,
        attachmentIDs: safeAttachments(item),
    };
    return { id: citationPaperNodeID(paper), ...paper };
}

async function resolveBibliographicItem(zotero, item) {
    if (item?.isRegularItem?.()) return item;
    if (!item?.isPDFAttachment?.()) throw parentRequiredError();
    try {
        if (item.parentItem) return item.parentItem;
    }
    catch {
        // Fall through to the numeric parent ID.
    }
    const parentItemID = item.parentItemID ?? item.parentID;
    if (parentItemID === null || parentItemID === undefined) {
        throw parentRequiredError();
    }
    return zotero.Items.getAsync(parentItemID);
}

async function loadItems(zotero, itemIDs) {
    if (!Array.isArray(itemIDs) || !itemIDs.length) return [];
    const loaded = await zotero.Items.getAsync(itemIDs);
    if (Array.isArray(loaded)) return loaded.filter(Boolean);
    return Promise.all(itemIDs.map(itemID => zotero.Items.getAsync(itemID)))
        .then(items => items.filter(Boolean));
}

function paperTitle(item) {
    const field = safeField(item, 'title');
    if (field) return boundedString(field, MAX_TITLE_LENGTH);
    try {
        return boundedString(item.getDisplayTitle?.(), MAX_TITLE_LENGTH)
            || '';
    }
    catch {
        return '';
    }
}

function paperYear(item) {
    const explicitField = safeField(item, 'year');
    const explicit = Number(explicitField);
    if (explicitField
        && Number.isSafeInteger(explicit)
        && explicit >= 0
        && explicit <= 9_999) {
        return explicit;
    }
    const match = /(?:^|\D)((?:18|19|20)\d{2})(?:\D|$)/
        .exec(safeField(item, 'date'));
    return match ? Number(match[1]) : 0;
}

function safeField(item, name) {
    try {
        return boundedString(item?.getField?.(name), name === 'extra'
            ? 16 * 1_024
            : 4_096);
    }
    catch {
        return '';
    }
}

function safeAttachments(item) {
    try {
        const values = item?.getAttachments?.();
        return Array.isArray(values)
            ? values.slice(0, MAX_ATTACHMENTS).filter(value => (
                Number.isSafeInteger(value) || typeof value === 'string'
            ))
            : [];
    }
    catch {
        return [];
    }
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum).trim() : '';
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

function parentRequiredError() {
    const error = new Error(
        'A parent bibliographic item is required for the citation graph'
    );
    error.code = 'CITATION_PARENT_REQUIRED';
    return error;
}
