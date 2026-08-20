import {
    buildCitationGraph,
    citationPaperNodeID,
} from './citation-graph-builder.js';

export class CitationGraph {
    constructor({
        library,
        client,
        cache,
        getAPIKey = () => '',
        createCacheKey,
        now = Date.now,
        defer = deferToNextTask,
        onCacheError = () => {},
    }) {
        if (typeof library?.listPapers !== 'function') {
            throw new TypeError('A citation library adapter is required');
        }
        if (typeof client?.resolvePapers !== 'function'
            || typeof client?.fetchReferences !== 'function') {
            throw new TypeError('A Semantic Scholar client is required');
        }
        if (typeof cache?.get !== 'function'
            || typeof cache?.put !== 'function') {
            throw new TypeError('A citation cache is required');
        }
        if (typeof createCacheKey !== 'function') {
            throw new TypeError('A citation cache key factory is required');
        }
        if (typeof defer !== 'function') {
            throw new TypeError('A citation refresh scheduler is required');
        }
        this.library = library;
        this.client = client;
        this.cache = cache;
        this.getAPIKey = getAPIKey;
        this.createCacheKey = createCacheKey;
        this.now = now;
        this.defer = defer;
        this.onCacheError = onCacheError;
    }

    async getLibraryGraph({
        libraryID,
        focusItemID = null,
        forceRefresh = false,
        signal,
        onProgress = () => {},
    } = {}) {
        throwIfAborted(signal);
        const papers = await this.library.listPapers(libraryID);
        throwIfAborted(signal);
        const records = new Map();
        const cacheKeys = new Map();
        const refreshPapers = [];
        const warnings = [];
        for (const paper of papers) {
            throwIfAborted(signal);
            const nodeID = paper.id || citationPaperNodeID(paper);
            paper.id = nodeID;
            if (!paper.doi && !paper.arxivID) continue;
            const cacheKey = await this.createCacheKey(paper);
            cacheKeys.set(nodeID, cacheKey);
            let cached = null;
            try {
                cached = await this.cache.get(cacheKey);
            }
            catch (error) {
                this.#cacheError(error);
                warnings.push({
                    code: 'cache-read-failed',
                    itemID: paper.itemID,
                });
            }
            if (cached?.record) records.set(nodeID, cached.record);
            if (cached?.stale) {
                warnings.push({ code: 'stale-cache', itemID: paper.itemID });
            }
            if (forceRefresh || !cached || cached.stale) refreshPapers.push(paper);
        }
        const initialProgress = {
            completed: 0,
            total: refreshPapers.length,
            failed: 0,
        };
        const snapshot = createSnapshot({
            libraryID,
            papers,
            records,
            selectedItemID: focusItemID,
            warnings,
            status: refreshPapers.length ? 'refreshing' : 'complete',
            progress: initialProgress,
            now: this.now,
        });
        if (!refreshPapers.length) {
            return { snapshot, completion: Promise.resolve(snapshot) };
        }
        const completion = this.defer(signal).then(() => this.#refresh({
            libraryID,
            papers,
            refreshPapers,
            records,
            cacheKeys,
            selectedItemID: focusItemID,
            warnings,
            signal,
            onProgress,
        }));
        return { snapshot, completion };
    }

    async #refresh({
        libraryID,
        papers,
        refreshPapers,
        records,
        cacheKeys,
        selectedItemID,
        warnings,
        signal,
        onProgress,
    }) {
        throwIfAborted(signal);
        const apiKey = String(this.getAPIKey() || '').trim();
        const progress = {
            completed: 0,
            total: refreshPapers.length,
            failed: 0,
        };
        const reportRetry = ({ stage, itemID = null }) => retry => {
            emitProgress(onProgress, createSnapshot({
                libraryID,
                papers,
                records,
                selectedItemID,
                warnings: [...warnings, {
                    ...retry,
                    stage,
                    itemID,
                    pending: true,
                }],
                status: 'refreshing',
                progress,
                now: this.now,
            }));
        };
        let resolved = new Map();
        try {
            resolved = await this.client.resolvePapers({
                papers: refreshPapers,
                apiKey,
                signal,
                onRetry: reportRetry({ stage: 'resolve' }),
            });
        }
        catch (error) {
            if (isAbortError(error) || signal?.aborted) throw abortReason(signal, error);
            warnings.push({ code: requestWarningCode(error), stage: 'resolve' });
        }
        for (const paper of refreshPapers) {
            const nodeID = paper.id || citationPaperNodeID(paper);
            const current = records.get(nodeID);
            const paperID = resolved.get(nodeID)?.paperID || current?.paperID || '';
            if (current?.status === 'fetched'
                && paperID
                && current.paperID !== paperID) {
                records.set(nodeID, { ...current, paperID });
            }
        }
        for (const paper of refreshPapers) {
            throwIfAborted(signal);
            const nodeID = paper.id || citationPaperNodeID(paper);
            try {
                const fetched = await this.client.fetchReferences({
                    doi: paper.doi,
                    arxivID: paper.arxivID,
                    apiKey,
                    signal,
                    onRetry: reportRetry({
                        stage: 'references',
                        itemID: paper.itemID,
                    }),
                });
                const record = {
                    ...fetched,
                    paperID: fetched.status === 'unindexed'
                        ? ''
                        : resolved.get(nodeID)?.paperID
                            || records.get(nodeID)?.paperID
                            || fetched.paperID
                            || '',
                };
                records.set(nodeID, record);
                if (record.truncated) {
                    warnings.push({
                        code: 'references-truncated',
                        itemID: paper.itemID,
                    });
                }
                try {
                    await this.cache.put(cacheKeys.get(nodeID), record);
                }
                catch (error) {
                    this.#cacheError(error);
                    warnings.push({
                        code: 'cache-write-failed',
                        itemID: paper.itemID,
                    });
                }
            }
            catch (error) {
                if (isAbortError(error) || signal?.aborted) {
                    throw abortReason(signal, error);
                }
                progress.failed++;
                warnings.push({
                    code: requestWarningCode(error),
                    itemID: paper.itemID,
                    stage: 'references',
                });
            }
            progress.completed++;
            const snapshot = createSnapshot({
                libraryID,
                papers,
                records,
                selectedItemID,
                warnings,
                status: progress.completed === progress.total
                    ? progress.failed ? 'partial' : 'complete'
                    : 'refreshing',
                progress,
                now: this.now,
            });
            emitProgress(onProgress, snapshot);
        }
        return createSnapshot({
            libraryID,
            papers,
            records,
            selectedItemID,
            warnings,
            status: progress.failed ? 'partial' : 'complete',
            progress,
            now: this.now,
        });
    }

    #cacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics are non-fatal by design.
        }
    }
}

function createSnapshot({
    libraryID,
    papers,
    records,
    selectedItemID,
    warnings,
    status,
    progress,
    now,
}) {
    const graph = buildCitationGraph({
        papers,
        records,
        selectedItemID,
        warnings: [...warnings],
    });
    const fetchedTimes = [...records.values()]
        .map(record => record?.fetchedAt)
        .filter(Number.isFinite);
    return {
        libraryID,
        ...graph,
        status,
        progress: { ...progress },
        fetchedAt: fetchedTimes.length ? Math.max(...fetchedTimes) : null,
        generatedAt: now(),
    };
}

function requestWarningCode(error) {
    return error?.code === 'S2_HTTP_ERROR' && error.status === 429
        ? 'rate-limited'
        : 'request-failed';
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal, fallback = null) {
    if (signal?.reason instanceof Error) return signal.reason;
    if (fallback?.name === 'AbortError') return fallback;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function emitProgress(onProgress, snapshot) {
    try {
        onProgress(snapshot);
    }
    catch {
        // Presentation callbacks cannot invalidate a successful refresh.
    }
}

function deferToNextTask(signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = callback => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutID);
            signal?.removeEventListener('abort', handleAbort);
            callback();
        };
        const handleAbort = () => finish(() => reject(abortReason(signal)));
        const timeoutID = setTimeout(() => finish(resolve), 0);
        signal?.addEventListener('abort', handleAbort, { once: true });
    });
}
