import { GFM, parser } from '@lezer/markdown';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from '../markdown/markdown-html.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const REVISION_SCHEMA_VERSION = 1;
const MAX_CORRECTION_BYTES = 256 * 1024;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const HEADING_PATTERN = /^ATXHeading[1-6]$/;

export async function openMarkdownRevisionSession({
    baseDocument,
    store,
    now = Date.now,
}) {
    validateBaseDocument(baseDocument);
    if (!store?.load || !store?.save || !store?.delete) {
        throw new TypeError('A Markdown revision store is required');
    }
    const stored = await store.load(baseDocument.cacheKey);
    const revision = stored
        ? validateStoredRevision(stored, baseDocument.cacheKey)
        : createRevision(baseDocument);
    return new MarkdownRevisionSession({ revision, store, now });
}

export function createMarkdownRevisionSessionRegistry({
    openSession = openMarkdownRevisionSession,
} = {}) {
    if (typeof openSession !== 'function') {
        throw new TypeError('A Markdown revision session opener is required');
    }
    const entries = new Map();
    const pending = new Map();

    const close = async itemID => {
        pending.delete(itemID);
        const entry = entries.get(itemID);
        if (!entry) return;
        entries.delete(itemID);
        await entry.session.destroy();
    };

    const destroyAll = async () => {
        pending.clear();
        const active = [...entries.values()];
        entries.clear();
        await Promise.all(active.map(entry => entry.session.destroy()));
    };

    return {
        get(itemID) {
            return entries.get(itemID);
        },

        async open(itemID, baseDocument, options = {}) {
            await close(itemID);
            throwIfAborted(options.signal);
            const token = {};
            pending.set(itemID, token);
            let session;
            try {
                session = await openSession({
                    baseDocument,
                    ...options,
                });
                if (pending.get(itemID) !== token
                    || options.signal?.aborted) {
                    await session.destroy();
                    throw abortError(options.signal);
                }
                const entry = {
                    cacheKey: baseDocument.cacheKey,
                    session,
                };
                pending.delete(itemID);
                entries.set(itemID, entry);
                return entry;
            }
            catch (error) {
                if (pending.get(itemID) === token) pending.delete(itemID);
                throw error;
            }
        },

        close,
        destroyAll,
    };
}

class MarkdownRevisionSession {
    constructor({ revision, store, now }) {
        this.revision = revision;
        this.store = store;
        this.now = now;
        this.operationTail = Promise.resolve();
    }

    snapshot() {
        return materializeRevision(this.revision);
    }

    commit({ blockID, replacementMarkdown }) {
        return this.#withOperation(async () => {
            const block = findRevisionBlock(this.revision, blockID);
            const replacement = validateReplacement(block, replacementMarkdown);
            const corrections = this.revision.corrections.filter(correction => (
                correction.blockID !== block.id
            ));
            if (replacement !== block.originalMarkdown) {
                corrections.push({
                    blockID: block.id,
                    originalMarkdown: block.originalMarkdown,
                    replacementMarkdown: replacement,
                    updatedAt: this.now(),
                });
            }
            const revision = {
                ...this.revision,
                corrections: sortCorrections(corrections, this.revision.blocks),
            };
            await this.#persist(revision);
            this.revision = revision;
            return this.snapshot();
        });
    }

    restore(blockID) {
        return this.#withOperation(async () => {
            findRevisionBlock(this.revision, blockID);
            const revision = {
                ...this.revision,
                corrections: this.revision.corrections.filter(correction => (
                    correction.blockID !== blockID
                )),
            };
            await this.#persist(revision);
            this.revision = revision;
            return this.snapshot();
        });
    }

    restoreAll() {
        return this.#withOperation(async () => {
            const revision = { ...this.revision, corrections: [] };
            await this.#persist(revision);
            this.revision = revision;
            return this.snapshot();
        });
    }

    async destroy() {
        await this.operationTail.catch(() => {});
    }

    async #persist(revision) {
        if (!revision.corrections.length) {
            await this.store.delete(revision.base.cacheKey);
            return;
        }
        await this.store.save(
            revision.base.cacheKey,
            cloneRevision(revision)
        );
    }

    #withOperation(operation) {
        const pending = this.operationTail.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending;
    }
}

function createRevision(baseDocument) {
    const base = cloneBaseDocument(baseDocument);
    return {
        schemaVersion: REVISION_SCHEMA_VERSION,
        base,
        blocks: collectEditableBlocks(base.markdown),
        corrections: [],
    };
}

function validateStoredRevision(value, cacheKey) {
    if (value?.schemaVersion !== REVISION_SCHEMA_VERSION
        || value.base?.cacheKey !== cacheKey
        || typeof value.base?.markdown !== 'string'
        || !Array.isArray(value.blocks)
        || !Array.isArray(value.corrections)) {
        throw new Error('Invalid saved Markdown revision');
    }
    const expectedBlocks = collectEditableBlocks(value.base.markdown);
    if (JSON.stringify(expectedBlocks) !== JSON.stringify(value.blocks)) {
        throw new Error('Saved Markdown revision blocks do not match its base');
    }
    const blockIDs = new Set(expectedBlocks.map(block => block.id));
    for (const correction of value.corrections) {
        if (!blockIDs.has(correction?.blockID)
            || typeof correction.originalMarkdown !== 'string'
            || typeof correction.replacementMarkdown !== 'string') {
            throw new Error('Invalid saved Markdown correction');
        }
        const block = expectedBlocks.find(candidate => (
            candidate.id === correction.blockID
        ));
        if (correction.originalMarkdown !== block.originalMarkdown) {
            throw new Error('Saved Markdown correction has a stale base');
        }
        validateReplacement(block, correction.replacementMarkdown);
    }
    return cloneRevision(value);
}

function materializeRevision(revision) {
    const corrections = new Map(revision.corrections.map(correction => [
        correction.blockID,
        correction,
    ]));
    const transforms = [];
    const editableBlocks = [];
    const chunks = [];
    let baseCursor = 0;
    let materializedLength = 0;
    for (const block of revision.blocks) {
        const prefix = revision.base.markdown.slice(baseCursor, block.baseFrom);
        chunks.push(prefix);
        materializedLength += prefix.length;
        const correction = corrections.get(block.id);
        const replacement = correction?.replacementMarkdown
            ?? block.originalMarkdown;
        const currentFrom = materializedLength;
        chunks.push(replacement);
        materializedLength += replacement.length;
        editableBlocks.push({
            id: block.id,
            type: block.type,
            from: currentFrom,
            to: materializedLength,
            originalMarkdown: block.originalMarkdown,
            markdown: replacement,
            corrected: Boolean(correction),
        });
        if (correction) {
            transforms.push({
                from: block.baseFrom,
                to: block.baseTo,
                replacementLength: replacement.length,
            });
        }
        baseCursor = block.baseTo;
    }
    const suffix = revision.base.markdown.slice(baseCursor);
    chunks.push(suffix);
    const markdown = chunks.join('');
    const sourceMap = transformSourceMap(
        revision.base.sourceMap || [],
        transforms
    );
    return {
        itemID: revision.base.itemID,
        cacheKey: revision.base.cacheKey,
        markdown,
        sourceMap,
        assets: cloneAssets(revision.base.assets || []),
        assetBasePath: revision.base.assetBasePath || '',
        extractedPages: revision.base.extractedPages ?? null,
        totalPages: revision.base.totalPages ?? null,
        editableBlocks,
        correctedBlockIDs: editableBlocks
            .filter(block => block.corrected)
            .map(block => block.id),
        correctionCount: revision.corrections.length,
        hasCorrections: revision.corrections.length > 0,
    };
}

function collectEditableBlocks(markdown) {
    const result = [];
    const tree = MARKDOWN_PARSER.parse(markdown);
    let ordinal = 0;
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const type = editableBlockType(node.name);
        if (!type) continue;
        const originalMarkdown = markdown.slice(node.from, node.to);
        if (containsMath(originalMarkdown)) continue;
        result.push({
            id: `block-${ordinal}-${node.from}-${node.to}-${type}`,
            type,
            baseFrom: node.from,
            baseTo: node.to,
            originalMarkdown,
        });
        ordinal++;
    }
    return result;
}

function containsMath(markdown) {
    return findInlineMathMatches(markdown).length > 0
        || findDisplayMathMatches(markdown).length > 0;
}

function editableBlockType(nodeName) {
    if (nodeName === 'Paragraph') return 'paragraph';
    if (nodeName === 'Table') return 'table';
    if (HEADING_PATTERN.test(nodeName)) return 'heading';
    return null;
}

function validateReplacement(block, value) {
    const replacement = String(value ?? '').replace(/\r\n?/g, '\n');
    if (new TextEncoder().encode(replacement).length > MAX_CORRECTION_BYTES) {
        throw new Error('The Markdown correction exceeds its size limit');
    }
    if (!replacement.trim()) {
        if (block.type !== 'paragraph' && block.type !== 'heading') {
            throw new Error(
                'Only paragraphs and headings can be deleted in correction mode'
            );
        }
        return '';
    }
    const tree = MARKDOWN_PARSER.parse(replacement);
    const nodes = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        nodes.push(node);
    }
    if (nodes.length !== 1) {
        throw new Error('A correction must contain one editable block');
    }
    const replacementType = editableBlockType(nodes[0].name);
    if (!replacementType
        || (block.type === 'heading'
            ? replacementType !== 'heading'
            : replacementType !== block.type)) {
        throw new Error('A correction must preserve its editable block type');
    }
    let containsImage = false;
    let containsRawHTML = false;
    tree.iterate({
        enter(node) {
            if (node.name === 'Image') containsImage = true;
            if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
                containsRawHTML = true;
            }
        },
    });
    if (containsImage) {
        throw new Error('Images cannot be added in correction mode');
    }
    if (containsRawHTML) {
        throw new Error('Raw HTML cannot be added in correction mode');
    }
    if (containsMath(replacement)) {
        throw new Error('Formulas cannot be added in correction mode');
    }
    return replacement;
}

function transformSourceMap(sourceMap, transforms) {
    return sourceMap.map(entry => {
        const corrected = transforms.some(transform => rangesOverlap(
            entry.markdownFrom,
            entry.markdownTo,
            transform.from,
            transform.to
        ));
        const transformed = {
            ...entry,
            markdownFrom: mapPosition(
                entry.markdownFrom,
                corrected ? -1 : 1,
                transforms
            ),
            markdownTo: mapPosition(
                entry.markdownTo,
                corrected ? 1 : -1,
                transforms
            ),
            locations: (entry.locations || []).map(location => ({
                ...location,
                bbox: [...location.bbox],
            })),
        };
        if (corrected) {
            delete transformed.locationRanges;
            transformed.corrected = true;
        }
        else if (Array.isArray(entry.locationRanges)) {
            transformed.locationRanges = entry.locationRanges.map(range => ({
                markdownFrom: mapPosition(range.markdownFrom, 1, transforms),
                markdownTo: mapPosition(range.markdownTo, -1, transforms),
                location: {
                    ...range.location,
                    bbox: [...range.location.bbox],
                },
            }));
        }
        return transformed;
    }).filter(entry => entry.markdownTo > entry.markdownFrom);
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function mapPosition(position, association, transforms) {
    let delta = 0;
    for (const transform of transforms) {
        const replacementFrom = transform.from + delta;
        const replacementTo = replacementFrom + transform.replacementLength;
        if (position < transform.from
            || (position === transform.from && association < 0)) {
            return position + delta;
        }
        if (position > transform.to
            || (position === transform.to && association > 0)) {
            delta += transform.replacementLength - (transform.to - transform.from);
            continue;
        }
        return association < 0 ? replacementFrom : replacementTo;
    }
    return position + delta;
}

function rangesOverlap(leftFrom, leftTo, rightFrom, rightTo) {
    return leftFrom < rightTo && leftTo > rightFrom;
}

function findRevisionBlock(revision, blockID) {
    const block = revision.blocks.find(candidate => candidate.id === blockID);
    if (!block) throw new Error('The Markdown correction block is unavailable');
    return block;
}

function sortCorrections(corrections, blocks) {
    const order = new Map(blocks.map((block, index) => [block.id, index]));
    return corrections.sort((left, right) => (
        order.get(left.blockID) - order.get(right.blockID)
    ));
}

function validateBaseDocument(value) {
    if (!value || typeof value.markdown !== 'string') {
        throw new TypeError('A base Markdown document is required');
    }
    if (!CACHE_KEY_PATTERN.test(value.cacheKey || '')) {
        throw new TypeError('A base Markdown cache key is required');
    }
    if (value.sourceMap !== undefined && !Array.isArray(value.sourceMap)) {
        throw new TypeError('The base Markdown source map must be an array');
    }
}

function cloneRevision(revision) {
    return {
        schemaVersion: revision.schemaVersion,
        base: cloneBaseDocument(revision.base),
        blocks: revision.blocks.map(block => ({ ...block })),
        corrections: revision.corrections.map(correction => ({ ...correction })),
    };
}

function cloneBaseDocument(document) {
    return {
        itemID: document.itemID,
        cacheKey: document.cacheKey,
        markdown: document.markdown,
        sourceMap: (document.sourceMap || []).map(entry => cloneSourceMapEntry(entry)),
        assets: cloneAssets(document.assets || []),
        assetBasePath: String(document.assetBasePath || ''),
        extractedPages: document.extractedPages ?? null,
        totalPages: document.totalPages ?? null,
    };
}

function cloneSourceMapEntry(entry) {
    return {
        ...entry,
        locations: (entry.locations || []).map(location => ({
            ...location,
            bbox: [...location.bbox],
        })),
        ...(Array.isArray(entry.locationRanges) ? {
            locationRanges: entry.locationRanges.map(range => ({
                ...range,
                location: {
                    ...range.location,
                    bbox: [...range.location.bbox],
                },
            })),
        } : {}),
    };
}

function cloneAssets(assets) {
    return assets.map(asset => ({
        ...asset,
        data: asset.data?.slice ? asset.data.slice() : asset.data,
    }));
}
