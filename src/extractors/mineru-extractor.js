export class MinerUConfigurationError extends Error {
    constructor() {
        super('Configure a MinerU API Token in the Mktero preferences');
        this.name = 'MinerUConfigurationError';
        this.code = 'MINERU_API_KEY_REQUIRED';
    }
}

export class MinerUDocumentExtractor {
    constructor({
        zotero,
        client,
        getApiKey,
        readFile,
        cache = null,
        createCacheKey = null,
        isCacheEnabled = () => false,
        onCacheError = error => zotero.logError?.(error),
    }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!client) throw new TypeError('A MinerU client is required');
        if (!getApiKey) throw new TypeError('A MinerU API Token provider is required');
        if (!readFile) throw new TypeError('A file reader is required');
        this.zotero = zotero;
        this.client = client;
        this.getApiKey = getApiKey;
        this.readFile = readFile;
        this.cache = cache;
        this.createCacheKey = createCacheKey;
        this.isCacheEnabled = isCacheEnabled;
        this.onCacheError = onCacheError;
    }

    async extract(itemID, { onProgress, signal, forceRefresh = false } = {}) {
        throwIfAborted(signal);
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can be converted');
        }

        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('The local PDF file is unavailable');
        }

        const fileData = await this.readFile(filePath);
        throwIfAborted(signal);
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        const cacheAvailable = Boolean(this.cache && this.createCacheKey);
        const cacheEnabled = cacheAvailable && Boolean(this.isCacheEnabled());
        const warnings = [];
        let cacheKey = null;
        if (cacheAvailable) {
            try {
                cacheKey = await this.createCacheKey(fileData);
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The local Markdown cache is unavailable.');
            }
        }
        if (cacheKey && !forceRefresh) {
            let cached = null;
            try {
                cached = await this.cache.get(cacheKey);
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The local Markdown cache could not be read.');
            }
            if (cached && (cacheEnabled || cached.userEdited)) {
                onProgress?.(100);
                return createResult(title, cached, true, warnings, cacheKey);
            }
        }

        const apiKey = String(this.getApiKey() || '').trim();
        if (!apiKey) throw new MinerUConfigurationError();

        const result = await this.client.parse({
            apiKey,
            fileName: item.attachmentFilename || `zotero-${itemID}.pdf`,
            fileData,
            dataID: `zotero-${itemID}`,
            onProgress,
            signal,
        });
        if (cacheKey && cacheEnabled) {
            try {
                await this.cache.put(cacheKey, result);
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The Markdown result could not be saved to the local cache.');
            }
        }
        return createResult(title, result, false, warnings, cacheKey);
    }

    async save(cacheEntry) {
        if (!this.cache) {
            throw new Error('The local Markdown cache is unavailable.');
        }
        if (!cacheEntry?.cacheKey) {
            throw new Error('This Markdown document has no local cache entry to update.');
        }
        try {
            await this.cache.put(cacheEntry.cacheKey, {
                ...cacheEntry,
                userEdited: true,
            }, { allowEmptyMarkdown: true });
        }
        catch (error) {
            this.#reportCacheError(error);
            throw error;
        }
    }

    #reportCacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics must not make PDF conversion fail.
        }
    }
}

function createResult(title, parsedResult, cacheHit, warnings = [], cacheKey = null) {
    const extracted = {
        kind: 'markdown',
        title,
        markdown: parsedResult.markdown,
        assets: parsedResult.assets || [],
        assetBasePath: parsedResult.assetBasePath || '',
        extractedPages: parsedResult.extractedPages,
        totalPages: parsedResult.totalPages,
        warnings,
        cacheHit,
    };
    if (cacheKey) extracted.cacheKey = cacheKey;
    if (parsedResult.userEdited) extracted.userEdited = true;
    return extracted;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
