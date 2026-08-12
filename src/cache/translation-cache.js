const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024;
const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function createZoteroTranslationCache({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) {
        throw new Error('The Zotero profile directory is unavailable');
    }
    return new TranslationCache({
        rootPath: pathUtils.join(profilePath, 'mktero-translations', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class TranslationCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    }) {
        if (!rootPath) throw new TypeError('A translation cache root is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (typeof ioUtils.stat !== 'function'
            || typeof ioUtils.getChildren !== 'function') {
            throw new TypeError('Bounded translation cache adapters are required');
        }
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
        this.maxEntryBytes = maxEntryBytes;
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
            validateFileSize(fileInfo, this.maxEntryBytes);
            const serialized = await this.io.readUTF8(filePath);
            if (byteLength(serialized) !== fileInfo.size) {
                throw new Error('Cached translation size is invalid');
            }
            const record = JSON.parse(serialized);
            validateRecord(record, cacheKey, this.maxEntryBytes);
            if (this.#isExpired(record)) {
                await this.#remove(filePath);
                return null;
            }
            const nextRecord = {
                ...record,
                lastAccessedAt: this.now(),
            };
            await this.#write(filePath, nextRecord).catch(() => {});
            return translationValue(record);
        }
        catch {
            await this.#remove(filePath);
            return null;
        }
    }

    put(cacheKey, translation) {
        validateCacheKey(cacheKey);
        validateTranslation(translation);
        return this.#withOperation(() => this.#put(cacheKey, translation));
    }

    async #put(cacheKey, translation) {
        const timestamp = this.now();
        const record = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            cacheKey,
            ...translationValue(translation),
            createdAt: timestamp,
            lastAccessedAt: timestamp,
        };
        const filePath = this.#filePath(cacheKey);
        await this.#ensureRoot();
        await this.#write(filePath, record);
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
                    if (removeInvalid && isTranslationCacheTempFile(fileName)) {
                        await this.#remove(filePath);
                    }
                    continue;
                }
                const fileInfo = await this.io.stat(filePath);
                validateFileSize(fileInfo, this.maxEntryBytes);
                const record = JSON.parse(await this.io.readUTF8(filePath));
                validateRecord(record, match[1], this.maxEntryBytes);
                if (this.#isExpired(record)) {
                    if (removeInvalid) await this.#remove(filePath);
                    continue;
                }
                entries.push({
                    filePath,
                    sizeBytes: fileInfo.size,
                    lastAccessedAt: record.lastAccessedAt,
                });
            }
            catch {
                if (removeInvalid) await this.#remove(filePath);
            }
        }
        entries.sort((left, right) => (
            left.lastAccessedAt - right.lastAccessedAt
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

    async #write(filePath, record) {
        const serialized = JSON.stringify(record);
        if (byteLength(serialized) > this.maxEntryBytes) {
            throw new Error('Translation cache entry exceeds the size limit');
        }
        const tmpPath = `${filePath}.tmp`;
        try {
            await this.io.writeUTF8(filePath, serialized, { tmpPath });
        }
        catch (error) {
            await this.#remove(tmpPath);
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

    #isExpired(record) {
        return this.now() - record.lastAccessedAt > this.maxAgeMs;
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
        throw new TypeError('A SHA-256 translation cache key is required');
    }
}

function validateFileSize(fileInfo, maxEntryBytes) {
    if (!Number.isSafeInteger(fileInfo?.size)
        || fileInfo.size < 0
        || fileInfo.size > maxEntryBytes
        || (fileInfo.type && fileInfo.type !== 'regular')) {
        throw new Error('Cached translation file size is invalid');
    }
}

function validateRecord(record, cacheKey, maxEntryBytes) {
    if (record?.schemaVersion !== CACHE_SCHEMA_VERSION
        || record.cacheKey !== cacheKey
        || !Number.isFinite(record.createdAt)
        || !Number.isFinite(record.lastAccessedAt)) {
        throw new Error('Cached translation metadata is invalid');
    }
    validateTranslation(record);
    if (byteLength(JSON.stringify(record)) > maxEntryBytes) {
        throw new Error('Cached translation exceeds the size limit');
    }
}

function validateTranslation(translation) {
    if (typeof translation?.text !== 'string'
        || !translation.text.trim()
        || typeof translation.model !== 'string'
        || !translation.model.trim()
        || typeof translation.targetLanguage !== 'string'
        || !translation.targetLanguage
        || typeof translation.promptVersion !== 'string'
        || !translation.promptVersion) {
        throw new TypeError('Invalid cached translation');
    }
}

function translationValue(value) {
    return {
        text: value.text,
        model: value.model,
        targetLanguage: value.targetLanguage,
        promptVersion: value.promptVersion,
    };
}

function byteLength(value) {
    return new TextEncoder().encode(value).length;
}

function isTranslationCacheTempFile(fileName) {
    return /^[0-9a-f]{64}\.json\.tmp$/.test(String(fileName || ''));
}
