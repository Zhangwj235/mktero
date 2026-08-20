import { sha256Hex } from '../core/sha256.js';

const CACHE_SCHEMA_VERSION = 1;
const QUERY_PROFILE = 'semantic-scholar-references-v1';
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_POSITIVE_FRESH_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_NEGATIVE_FRESH_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REFERENCES = 1_000;

export async function createCitationCacheKey(paper, {
    crypto = globalThis.crypto,
    queryProfile = QUERY_PROFILE,
} = {}) {
    const descriptor = [
        `cache-schema:${CACHE_SCHEMA_VERSION}`,
        `query-profile:${String(queryProfile || '')}`,
        `library-id:${String(paper?.libraryID ?? '')}`,
        `item-key:${String(paper?.key ?? '')}`,
        `doi:${String(paper?.doi || '')}`,
        `arxiv:${String(paper?.arxivID || '')}`,
    ].join('\n');
    return sha256Hex(new TextEncoder().encode(descriptor), { crypto });
}

export function createZoteroCitationGraphCache({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) {
        throw new Error('The Zotero profile directory is unavailable');
    }
    return new CitationGraphCache({
        rootPath: pathUtils.join(profilePath, 'mktero-citations', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class CitationGraphCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        positiveFreshMs = DEFAULT_POSITIVE_FRESH_MS,
        negativeFreshMs = DEFAULT_NEGATIVE_FRESH_MS,
    }) {
        if (!rootPath) throw new TypeError('A citation cache root is required');
        if (!ioUtils
            || typeof ioUtils.stat !== 'function'
            || typeof ioUtils.getChildren !== 'function') {
            throw new TypeError('Bounded citation cache adapters are required');
        }
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxEntryBytes = maxEntryBytes;
        this.maxAgeMs = maxAgeMs;
        this.positiveFreshMs = positiveFreshMs;
        this.negativeFreshMs = negativeFreshMs;
        this.operationTail = Promise.resolve();
    }

    get(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#get(cacheKey));
    }

    async #get(cacheKey) {
        const filePath = this.#filePath(cacheKey);
        if (!(await this.io.exists(filePath))) return null;
        try {
            const fileInfo = await this.io.stat(filePath);
            validateFileInfo(fileInfo, this.maxEntryBytes);
            const serialized = await this.io.readUTF8(filePath);
            if (byteLength(serialized) !== fileInfo.size) {
                throw new Error('Cached citation size is invalid');
            }
            const entry = JSON.parse(serialized);
            validateEntry(entry, cacheKey, this.maxEntryBytes);
            if (this.now() - entry.lastAccessedAt > this.maxAgeMs) {
                await this.#remove(filePath);
                return null;
            }
            const result = {
                record: citationRecord(entry.record),
                stale: this.#isStale(entry.record),
            };
            const updated = { ...entry, lastAccessedAt: this.now() };
            await this.#write(filePath, updated).catch(() => {});
            return result;
        }
        catch {
            await this.#remove(filePath);
            return null;
        }
    }

    put(cacheKey, record) {
        validateCacheKey(cacheKey);
        validateRecord(record);
        return this.#withOperation(() => this.#put(cacheKey, record));
    }

    async #put(cacheKey, record) {
        const timestamp = this.now();
        const entry = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            cacheKey,
            record: citationRecord(record),
            createdAt: timestamp,
            lastAccessedAt: timestamp,
        };
        await this.#ensureRoot();
        await this.#write(this.#filePath(cacheKey), entry);
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    prune() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: true,
            enforceLimits: true,
        }));
    }

    getStats() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: false,
            enforceLimits: false,
        }));
    }

    clear() {
        return this.#withOperation(async () => {
            await this.io.remove(this.rootPath, {
                recursive: true,
                ignoreAbsent: true,
            });
            await this.#ensureRoot();
        });
    }

    async #scan({ removeInvalid, enforceLimits }) {
        if (!(await this.io.exists(this.rootPath))) {
            return { entries: 0, sizeBytes: 0 };
        }
        const entries = [];
        for (const filePath of await this.io.getChildren(this.rootPath)) {
            try {
                const fileName = this.path.filename(filePath);
                const match = /^([0-9a-f]{64})\.json$/.exec(fileName);
                if (!match) {
                    if (removeInvalid && isTemporaryFile(fileName)) {
                        await this.#remove(filePath);
                    }
                    continue;
                }
                const fileInfo = await this.io.stat(filePath);
                validateFileInfo(fileInfo, this.maxEntryBytes);
                const serialized = await this.io.readUTF8(filePath);
                if (byteLength(serialized) !== fileInfo.size) {
                    throw new Error('Cached citation size is invalid');
                }
                const entry = JSON.parse(serialized);
                validateEntry(entry, match[1], this.maxEntryBytes);
                if (this.now() - entry.lastAccessedAt > this.maxAgeMs) {
                    if (removeInvalid) await this.#remove(filePath);
                    continue;
                }
                entries.push({
                    filePath,
                    sizeBytes: fileInfo.size,
                    lastAccessedAt: entry.lastAccessedAt,
                });
            }
            catch {
                if (removeInvalid) await this.#remove(filePath);
            }
        }
        entries.sort((left, right) => (
            left.lastAccessedAt - right.lastAccessedAt
            || left.filePath.localeCompare(right.filePath)
        ));
        let sizeBytes = entries.reduce(
            (total, entry) => total + entry.sizeBytes,
            0
        );
        let count = entries.length;
        if (enforceLimits) {
            for (const entry of entries) {
                if (count <= this.maxEntries && sizeBytes <= this.maxBytes) break;
                await this.#remove(entry.filePath);
                count--;
                sizeBytes -= entry.sizeBytes;
            }
        }
        return { entries: count, sizeBytes };
    }

    async #write(filePath, entry) {
        const serialized = JSON.stringify(entry);
        if (byteLength(serialized) > this.maxEntryBytes) {
            throw new Error('Citation cache entry exceeds the size limit');
        }
        const temporaryPath = `${filePath}.tmp`;
        try {
            await this.io.writeUTF8(filePath, serialized, {
                tmpPath: temporaryPath,
            });
        }
        catch (error) {
            await this.#remove(temporaryPath);
            throw error;
        }
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
    }

    #filePath(cacheKey) {
        return this.path.join(this.rootPath, `${cacheKey}.json`);
    }

    #isStale(record) {
        const freshMs = record.status === 'unindexed'
            ? this.negativeFreshMs
            : this.positiveFreshMs;
        return this.now() - record.fetchedAt > freshMs;
    }

    #remove(filePath) {
        return this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {});
    }

    async #withOperation(operation) {
        const previous = this.operationTail;
        const pending = previous.catch(() => {}).then(operation);
        this.operationTail = pending;
        try {
            return await pending;
        }
        finally {
            if (this.operationTail === pending) {
                this.operationTail = Promise.resolve();
            }
        }
    }
}

function validateCacheKey(cacheKey) {
    if (!CACHE_KEY_PATTERN.test(String(cacheKey || ''))) {
        throw new TypeError('A SHA-256 citation cache key is required');
    }
}

function validateEntry(entry, cacheKey, maxEntryBytes) {
    if (entry?.schemaVersion !== CACHE_SCHEMA_VERSION
        || entry.cacheKey !== cacheKey
        || !Number.isFinite(entry.createdAt)
        || !Number.isFinite(entry.lastAccessedAt)) {
        throw new Error('Cached citation metadata is invalid');
    }
    validateRecord(entry.record);
    if (byteLength(JSON.stringify(entry)) > maxEntryBytes) {
        throw new Error('Cached citation entry exceeds the size limit');
    }
}

function validateRecord(record) {
    if (!['fetched', 'unindexed'].includes(record?.status)
        || typeof record.paperID !== 'string'
        || record.paperID.length > 4_096
        || !Array.isArray(record.references)
        || record.references.length > MAX_REFERENCES
        || typeof record.truncated !== 'boolean'
        || !Number.isFinite(record.fetchedAt)) {
        throw new TypeError('Invalid cached citation record');
    }
    if (record.status === 'unindexed'
        && (record.paperID || record.references.length || record.truncated)) {
        throw new TypeError('Invalid negative citation record');
    }
    for (const reference of record.references) validateReference(reference);
}

function validateReference(reference) {
    if (!reference || typeof reference !== 'object'
        || typeof reference.paperID !== 'string'
        || reference.paperID.length > 4_096
        || typeof reference.title !== 'string'
        || reference.title.length > 512
        || !Number.isSafeInteger(reference.year)
        || reference.year < 0
        || reference.year > 9_999
        || typeof reference.doi !== 'string'
        || reference.doi.length > 4_096
        || typeof reference.arxivID !== 'string'
        || reference.arxivID.length > 4_096
        || !Array.isArray(reference.authors)
        || reference.authors.length > 100
        || reference.authors.some(author => (
            typeof author !== 'string' || author.length > 512
        ))) {
        throw new TypeError('Invalid cached citation reference');
    }
}

function citationRecord(record) {
    return {
        status: record.status,
        paperID: record.paperID,
        references: record.references.map(reference => ({
            paperID: reference.paperID,
            title: reference.title,
            year: reference.year,
            doi: reference.doi,
            arxivID: reference.arxivID,
            authors: [...reference.authors],
        })),
        truncated: record.truncated,
        fetchedAt: record.fetchedAt,
    };
}

function validateFileInfo(fileInfo, maximum) {
    if (!Number.isSafeInteger(fileInfo?.size)
        || fileInfo.size < 0
        || fileInfo.size > maximum
        || (fileInfo.type && fileInfo.type !== 'regular')) {
        throw new Error('Cached citation file size is invalid');
    }
}

function byteLength(value) {
    return new TextEncoder().encode(value).length;
}

function isTemporaryFile(fileName) {
    return /^[0-9a-f]{64}\.json\.tmp$/.test(String(fileName || ''));
}
