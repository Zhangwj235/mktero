const STORE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'metadata.json';
const MARKDOWN_FILE = 'base.md';
const SOURCE_MAP_FILE = 'source-map.json';
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CORRECTIONS_FILE_PATTERN = /^corrections-\d+-\d+\.json$/;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 20 * 1024 * 1024;
const MAX_CORRECTIONS_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_ASSETS = 1_000;

export function createZoteroMarkdownRevisionStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new ZoteroMarkdownRevisionStore({
        rootPath: pathUtils.join(profilePath, 'mktero-revisions', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class ZoteroMarkdownRevisionStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
    }) {
        if (!rootPath) throw new TypeError('A Markdown revision root is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.writeSequence = 0;
        this.operationTail = Promise.resolve();
    }

    load(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#load(cacheKey));
    }

    save(cacheKey, revision) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#save(cacheKey, revision));
    }

    delete(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.io.remove(
            this.#entryPath(cacheKey),
            { recursive: true, ignoreAbsent: true }
        ));
    }

    async #load(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        const metadata = await this.#readMetadata(metadataPath, cacheKey);
        const [markdown, sourceMapJSON, correctionsJSON, assets] = await Promise.all([
            this.#readSizedUTF8(
                this.path.join(entryPath, MARKDOWN_FILE),
                metadata.markdownBytes,
                MAX_MARKDOWN_BYTES,
                'Markdown revision base'
            ),
            this.#readSizedUTF8(
                this.path.join(entryPath, SOURCE_MAP_FILE),
                metadata.sourceMapBytes,
                MAX_SOURCE_MAP_BYTES,
                'Markdown revision source map'
            ),
            this.#readSizedUTF8(
                this.path.join(entryPath, metadata.correctionsFile),
                metadata.correctionsBytes,
                MAX_CORRECTIONS_BYTES,
                'Markdown revision corrections'
            ),
            Promise.all(metadata.assets.map(async asset => ({
                path: asset.path,
                mimeType: asset.mimeType,
                data: await this.#readSizedBinary(
                    this.path.join(entryPath, 'assets', asset.file),
                    asset.size,
                    'Markdown revision asset'
                ),
            }))),
        ]);
        let sourceMap;
        let correctionData;
        try {
            sourceMap = JSON.parse(sourceMapJSON);
            correctionData = JSON.parse(correctionsJSON);
        }
        catch (error) {
            throw new Error('Invalid Markdown revision data', { cause: error });
        }
        if (!Array.isArray(sourceMap)
            || !Array.isArray(correctionData?.blocks)
            || !Array.isArray(correctionData?.corrections)) {
            throw new Error('Invalid Markdown revision data');
        }
        return {
            schemaVersion: STORE_SCHEMA_VERSION,
            base: {
                itemID: metadata.itemID,
                cacheKey,
                markdown,
                sourceMap,
                assets,
                assetBasePath: metadata.assetBasePath,
                extractedPages: metadata.extractedPages,
                totalPages: metadata.totalPages,
            },
            blocks: correctionData.blocks,
            corrections: correctionData.corrections,
        };
    }

    async #save(cacheKey, revision) {
        validateRevision(revision, cacheKey);
        await this.#ensureRoot();
        const entryPath = this.#entryPath(cacheKey);
        const assetsPath = this.path.join(entryPath, 'assets');
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        await this.io.makeDirectory(assetsPath, { ignoreExisting: true });

        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previous = await this.#readOptionalMetadata(metadataPath, cacheKey);
        const serialized = serializeRevision(revision);
        if (!previous) {
            await this.#writeImmutableBase(entryPath, assetsPath, serialized);
        }
        else {
            validateImmutableBase(previous, serialized.metadata);
        }

        const correctionsFile = [
            'corrections-',
            Math.max(0, Math.trunc(this.now())),
            '-',
            this.writeSequence++,
            '.json',
        ].join('');
        const correctionsPath = this.path.join(entryPath, correctionsFile);
        await this.io.writeUTF8(correctionsPath, serialized.correctionsJSON, {
            tmpPath: `${correctionsPath}.tmp`,
        });
        const metadata = {
            ...serialized.metadata,
            correctionsFile,
            correctionsBytes: serialized.correctionsBytes,
        };
        await this.io.writeUTF8(metadataPath, JSON.stringify(metadata), {
            tmpPath: `${metadataPath}.tmp`,
        });
        if (previous?.correctionsFile
            && previous.correctionsFile !== correctionsFile) {
            await this.io.remove(
                this.path.join(entryPath, previous.correctionsFile),
                { ignoreAbsent: true }
            ).catch(() => {});
        }
    }

    async #writeImmutableBase(entryPath, assetsPath, serialized) {
        const markdownPath = this.path.join(entryPath, MARKDOWN_FILE);
        const sourceMapPath = this.path.join(entryPath, SOURCE_MAP_FILE);
        await this.io.writeUTF8(markdownPath, serialized.markdown, {
            tmpPath: `${markdownPath}.tmp`,
        });
        await this.io.writeUTF8(sourceMapPath, serialized.sourceMapJSON, {
            tmpPath: `${sourceMapPath}.tmp`,
        });
        await Promise.all(serialized.assets.map(async asset => {
            const assetPath = this.path.join(assetsPath, asset.file);
            await this.io.write(assetPath, asset.data, {
                tmpPath: `${assetPath}.tmp`,
            });
        }));
    }

    async #readOptionalMetadata(metadataPath, cacheKey) {
        if (!(await this.io.exists(metadataPath))) return null;
        return this.#readMetadata(metadataPath, cacheKey);
    }

    async #readMetadata(metadataPath, cacheKey) {
        let metadata;
        try {
            metadata = JSON.parse(await this.io.readUTF8(metadataPath));
        }
        catch (error) {
            throw new Error('Invalid revision metadata', { cause: error });
        }
        validateMetadata(metadata, cacheKey);
        return metadata;
    }

    async #readSizedUTF8(filePath, expectedBytes, maxBytes, label) {
        const info = await this.io.stat(filePath);
        if (!Number.isSafeInteger(info?.size)
            || info.size !== expectedBytes
            || info.size > maxBytes) {
            throw new Error(`${label} size is invalid`);
        }
        return this.io.readUTF8(filePath);
    }

    async #readSizedBinary(filePath, expectedBytes, label) {
        const info = await this.io.stat(filePath);
        if (!Number.isSafeInteger(info?.size) || info.size !== expectedBytes) {
            throw new Error(`${label} size is invalid`);
        }
        return this.io.read(filePath);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.path.join(this.rootPath, 'entries'), {
            ignoreExisting: true,
        });
    }

    #entryPath(cacheKey) {
        return this.path.join(this.rootPath, 'entries', cacheKey);
    }

    async #withOperation(operation) {
        const pending = this.operationTail.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending;
    }
}

function serializeRevision(revision) {
    const encoder = new TextEncoder();
    const markdown = revision.base.markdown;
    const sourceMapJSON = JSON.stringify(revision.base.sourceMap || []);
    const correctionsJSON = JSON.stringify({
        blocks: revision.blocks,
        corrections: revision.corrections,
    });
    const markdownBytes = encoder.encode(markdown).length;
    const sourceMapBytes = encoder.encode(sourceMapJSON).length;
    const correctionsBytes = encoder.encode(correctionsJSON).length;
    if (markdownBytes > MAX_MARKDOWN_BYTES) {
        throw new Error('The Markdown revision base exceeds its size limit');
    }
    if (sourceMapBytes > MAX_SOURCE_MAP_BYTES) {
        throw new Error('The Markdown revision source map exceeds its size limit');
    }
    if (correctionsBytes > MAX_CORRECTIONS_BYTES) {
        throw new Error('The Markdown revision corrections exceed their size limit');
    }
    if ((revision.base.assets || []).length > MAX_ASSETS) {
        throw new Error('The Markdown revision has too many assets');
    }
    let totalAssetBytes = 0;
    const assets = (revision.base.assets || []).map((asset, index) => {
        const data = asset.data instanceof Uint8Array
            ? asset.data
            : new Uint8Array(asset.data || []);
        totalAssetBytes += data.length;
        return {
            file: `${String(index).padStart(4, '0')}.bin`,
            path: String(asset.path || ''),
            mimeType: String(asset.mimeType || ''),
            size: data.length,
            data,
        };
    });
    if (totalAssetBytes > MAX_ASSET_BYTES) {
        throw new Error('The Markdown revision assets exceed their size limit');
    }
    return {
        markdown,
        sourceMapJSON,
        correctionsJSON,
        correctionsBytes,
        assets,
        metadata: {
            schemaVersion: STORE_SCHEMA_VERSION,
            cacheKey: revision.base.cacheKey,
            itemID: revision.base.itemID ?? null,
            markdownBytes,
            sourceMapBytes,
            assetBasePath: String(revision.base.assetBasePath || ''),
            extractedPages: revision.base.extractedPages ?? null,
            totalPages: revision.base.totalPages ?? null,
            assets: assets.map(({ data: _data, ...asset }) => asset),
        },
    };
}

function validateRevision(revision, cacheKey) {
    if (revision?.schemaVersion !== STORE_SCHEMA_VERSION
        || revision.base?.cacheKey !== cacheKey
        || typeof revision.base?.markdown !== 'string'
        || !Array.isArray(revision.blocks)
        || !Array.isArray(revision.corrections)) {
        throw new TypeError('Invalid Markdown revision');
    }
}

function validateMetadata(metadata, cacheKey) {
    if (metadata?.schemaVersion !== STORE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || !validSize(metadata.markdownBytes, MAX_MARKDOWN_BYTES)
        || !validSize(metadata.sourceMapBytes, MAX_SOURCE_MAP_BYTES)
        || !validSize(metadata.correctionsBytes, MAX_CORRECTIONS_BYTES)
        || !CORRECTIONS_FILE_PATTERN.test(metadata.correctionsFile || '')
        || typeof metadata.assetBasePath !== 'string'
        || !Array.isArray(metadata.assets)
        || metadata.assets.length > MAX_ASSETS) {
        throw new Error('Invalid revision metadata');
    }
    let totalAssetBytes = 0;
    for (const asset of metadata.assets) {
        if (!/^\d{4}\.bin$/.test(asset?.file || '')
            || typeof asset.path !== 'string'
            || !asset.path
            || typeof asset.mimeType !== 'string'
            || !validSize(asset.size, MAX_ASSET_BYTES)) {
            throw new Error('Invalid revision metadata');
        }
        totalAssetBytes += asset.size;
    }
    if (totalAssetBytes > MAX_ASSET_BYTES) {
        throw new Error('Invalid revision metadata');
    }
}

function validateImmutableBase(previous, next) {
    const fields = [
        'markdownBytes',
        'sourceMapBytes',
        'assetBasePath',
        'extractedPages',
        'totalPages',
    ];
    if (fields.some(field => previous[field] !== next[field])
        || JSON.stringify(previous.assets) !== JSON.stringify(next.assets)) {
        throw new Error('The saved Markdown revision base cannot be replaced');
    }
}

function validSize(value, maximum) {
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateCacheKey(cacheKey) {
    if (!CACHE_KEY_PATTERN.test(cacheKey || '')) {
        throw new TypeError('Invalid Markdown revision cache key');
    }
}
