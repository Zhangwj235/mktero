import {
    buildCitationGraph,
    citationPaperNodeID,
} from './citation-graph-builder.js';
import {
    normalizeArxivID,
    normalizeDOI,
} from './citation-identifiers.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';

const DEFAULT_REQUEST_WINDOW_MS = 6_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 2;
const DEFAULT_CIRCUIT_OPEN_MS = 5 * 60 * 1_000;
const MAX_MERGED_REFERENCES = 1_000;

export class CitationGraph {
    constructor({
        library,
        providers,
        cache,
        createCacheKey,
        now = Date.now,
        defer = deferToNextTask,
        createAbortController = createRuntimeAbortController,
        setTimer = globalThis.setTimeout?.bind(globalThis),
        clearTimer = globalThis.clearTimeout?.bind(globalThis),
        requestWindowMs = DEFAULT_REQUEST_WINDOW_MS,
        circuitFailureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
        circuitOpenMs = DEFAULT_CIRCUIT_OPEN_MS,
        onCacheError = () => {},
    }) {
        if (typeof library?.listPapers !== 'function') {
            throw new TypeError('A citation library adapter is required');
        }
        if (!Array.isArray(providers) || !providers.length) {
            throw new TypeError('Citation providers are required');
        }
        const providerIDs = new Set();
        for (const provider of providers) {
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider?.id || '')
                || providerIDs.has(provider.id)
                || typeof provider?.client?.supports !== 'function'
                || typeof provider?.client?.fetchReferences !== 'function'
                || typeof provider?.getAPIKey !== 'function') {
                throw new TypeError('A valid unique citation provider is required');
            }
            providerIDs.add(provider.id);
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
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
            throw new TypeError('Timer adapters are required');
        }
        this.library = library;
        this.providers = [...providers];
        this.cache = cache;
        this.createCacheKey = createCacheKey;
        this.now = now;
        this.defer = defer;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.requestWindowMs = boundedInteger(
            requestWindowMs,
            1_000,
            60_000,
            DEFAULT_REQUEST_WINDOW_MS
        );
        this.circuitFailureThreshold = boundedInteger(
            circuitFailureThreshold,
            1,
            10,
            DEFAULT_CIRCUIT_FAILURE_THRESHOLD
        );
        this.circuitOpenMs = boundedInteger(
            circuitOpenMs,
            1_000,
            60 * 60 * 1_000,
            DEFAULT_CIRCUIT_OPEN_MS
        );
        this.onCacheError = onCacheError;
        this.providerFailures = new Map();
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
        for (const paper of papers) {
            paper.id = paper.id || citationPaperNodeID(paper);
        }
        const focus = papers.find(paper => sameItemID(
            paper.itemID,
            focusItemID
        ));
        const providerRecords = new Map();
        const refreshStates = [];
        const warnings = [];
        if (focus) {
            for (const provider of this.providers) {
                if (!providerSupports(provider, focus)) continue;
                const cacheKey = await this.createCacheKey(focus, {
                    providerID: provider.id,
                    scopeIdentifiers: providerCacheScope(
                        provider,
                        papers,
                        focus
                    ),
                });
                let cached = null;
                try {
                    cached = await this.cache.get(cacheKey);
                }
                catch (error) {
                    this.#cacheError(error);
                    warnings.push({
                        code: 'cache-read-failed',
                        itemID: focus.itemID,
                        providerID: provider.id,
                    });
                }
                if (cached?.record) {
                    providerRecords.set(
                        provider.id,
                        recordWithProvider(cached.record, provider.id)
                    );
                }
                if (cached?.stale) {
                    warnings.push({
                        code: 'stale-cache',
                        itemID: focus.itemID,
                        providerID: provider.id,
                    });
                }
                if (forceRefresh || !cached || cached.stale) {
                    refreshStates.push({ provider, cacheKey });
                }
            }
        }
        const progress = {
            completed: 0,
            total: refreshStates.length,
            failed: 0,
        };
        const snapshot = createSnapshot({
            libraryID,
            papers,
            focus,
            providerRecords,
            selectedItemID: focusItemID,
            warnings,
            status: refreshStates.length ? 'refreshing' : 'complete',
            progress,
            now: this.now,
        });
        if (!refreshStates.length || !focus) {
            return { snapshot, completion: Promise.resolve(snapshot) };
        }
        const completion = this.defer(signal).then(() => this.#refresh({
            libraryID,
            papers,
            focus,
            providerRecords,
            refreshStates,
            selectedItemID: focusItemID,
            warnings,
            progress,
            signal,
            onProgress,
        }));
        return { snapshot, completion };
    }

    async #refresh({
        libraryID,
        papers,
        focus,
        providerRecords,
        refreshStates,
        selectedItemID,
        warnings,
        progress,
        signal,
        onProgress,
    }) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
        let deadlineExpired = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = this.setTimer(() => {
            deadlineExpired = true;
            controller.abort();
        }, this.requestWindowMs);
        const snapshot = (status, extraWarnings = []) => createSnapshot({
            libraryID,
            papers,
            focus,
            providerRecords,
            selectedItemID,
            warnings: [...warnings, ...extraWarnings],
            status,
            progress,
            now: this.now,
        });
        try {
            const tasks = refreshStates.map(state => this.#refreshProvider({
                state,
                papers,
                focus,
                providerRecords,
                warnings,
                progress,
                signal,
                requestSignal: controller.signal,
                deadlineExpired: () => deadlineExpired,
                publish: extraWarnings => emitProgress(
                    onProgress,
                    snapshot('refreshing', extraWarnings)
                ),
                publishSettled: () => emitProgress(
                    onProgress,
                    snapshot(
                        progress.completed === progress.total
                            ? progress.failed ? 'partial' : 'complete'
                            : 'refreshing'
                    )
                ),
            }));
            await Promise.allSettled(tasks);
            throwIfAborted(signal);
            return snapshot(progress.failed ? 'partial' : 'complete');
        }
        finally {
            this.clearTimer(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
            if (!controller.signal?.aborted) controller.abort();
        }
    }

    async #refreshProvider({
        state,
        papers,
        focus,
        providerRecords,
        warnings,
        progress,
        signal,
        requestSignal,
        deadlineExpired,
        publish,
        publishSettled,
    }) {
        const { provider, cacheKey } = state;
        try {
            if (this.#isCircuitOpen(provider.id)) {
                progress.failed++;
                warnings.push({
                    code: 'provider-circuit-open',
                    itemID: focus.itemID,
                    providerID: provider.id,
                });
                return;
            }
            const record = recordWithProvider(
                await provider.client.fetchReferences({
                    doi: focus.doi,
                    arxivID: focus.arxivID,
                    papers,
                    apiKey: String(provider.getAPIKey() || '').trim(),
                    signal: requestSignal,
                    onRetry: retry => publish([{
                        ...retry,
                        itemID: focus.itemID,
                        providerID: provider.id,
                        pending: true,
                    }]),
                }),
                provider.id
            );
            providerRecords.set(provider.id, record);
            this.providerFailures.delete(provider.id);
            if (record.truncated) {
                warnings.push({
                    code: 'references-truncated',
                    itemID: focus.itemID,
                    providerID: provider.id,
                });
            }
            publish([]);
            try {
                await waitForPromise(
                    this.cache.put(cacheKey, record),
                    requestSignal
                );
            }
            catch (error) {
                if (signal?.aborted) throw abortReason(signal, error);
                if (requestSignal?.aborted && deadlineExpired()) return;
                this.#cacheError(error);
                warnings.push({
                    code: 'cache-write-failed',
                    itemID: focus.itemID,
                    providerID: provider.id,
                });
            }
        }
        catch (error) {
            if (signal?.aborted) throw abortReason(signal, error);
            progress.failed++;
            const timedOut = deadlineExpired() && isAbortError(error);
            warnings.push({
                code: timedOut ? 'request-timeout' : requestWarningCode(error),
                itemID: focus.itemID,
                providerID: provider.id,
            });
            this.#recordProviderFailure(provider.id);
        }
        finally {
            progress.completed++;
            publishSettled();
        }
    }

    #isCircuitOpen(providerID) {
        const state = this.providerFailures.get(providerID);
        if (!state?.openUntil) return false;
        if (this.now() < state.openUntil) return true;
        this.providerFailures.delete(providerID);
        return false;
    }

    #recordProviderFailure(providerID) {
        const previous = this.providerFailures.get(providerID) || {
            failures: 0,
            openUntil: 0,
        };
        const failures = previous.failures + 1;
        this.providerFailures.set(providerID, {
            failures,
            openUntil: failures >= this.circuitFailureThreshold
                ? this.now() + this.circuitOpenMs
                : 0,
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
    focus,
    providerRecords,
    selectedItemID,
    warnings,
    status,
    progress,
    now,
}) {
    const records = new Map();
    const merged = mergeProviderRecords(providerRecords);
    if (focus && merged) records.set(focus.id, merged);
    const graph = buildCitationGraph({
        papers,
        records,
        selectedItemID,
        warnings: [...warnings],
    });
    const fetchedTimes = [...providerRecords.values()]
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

function mergeProviderRecords(providerRecords) {
    if (!providerRecords.size) return null;
    const references = new Map();
    let paperID = '';
    let truncated = false;
    let fetchedAt = 0;
    for (const record of providerRecords.values()) {
        paperID ||= boundedString(record?.paperID, 4_096);
        truncated ||= Boolean(record?.truncated);
        if (Number.isFinite(record?.fetchedAt)) {
            fetchedAt = Math.max(fetchedAt, record.fetchedAt);
        }
        for (const reference of Array.isArray(record?.references)
            ? record.references
            : []) {
            const doi = normalizeDOI(reference?.doi);
            const arxivID = normalizeArxivID(reference?.arxivID);
            const key = doi ? `doi:${doi}` : arxivID ? `arxiv:${arxivID}` : '';
            if (!key) continue;
            const current = references.get(key);
            if (!current) {
                if (references.size >= MAX_MERGED_REFERENCES) {
                    truncated = true;
                    continue;
                }
                references.set(key, {
                    paperID: boundedString(reference?.paperID, 4_096),
                    title: boundedString(reference?.title, 512),
                    year: normalizedYear(reference?.year),
                    doi,
                    arxivID,
                    authors: normalizedAuthors(reference?.authors),
                    sources: normalizedSources(reference?.sources),
                });
                continue;
            }
            current.paperID ||= boundedString(reference?.paperID, 4_096);
            current.title ||= boundedString(reference?.title, 512);
            current.year ||= normalizedYear(reference?.year);
            current.doi ||= doi;
            current.arxivID ||= arxivID;
            if (!current.authors.length) {
                current.authors = normalizedAuthors(reference?.authors);
            }
            current.sources = normalizedSources([
                ...current.sources,
                ...(Array.isArray(reference?.sources) ? reference.sources : []),
            ]);
        }
    }
    const mergedReferences = [...references.values()];
    return {
        status: mergedReferences.length ? 'fetched' : 'unindexed',
        paperID: mergedReferences.length ? paperID : '',
        references: mergedReferences,
        truncated,
        fetchedAt,
    };
}

function recordWithProvider(record, providerID) {
    const references = Array.isArray(record?.references)
        ? record.references.map(reference => ({
            ...reference,
            sources: normalizedSources([
                ...(Array.isArray(reference?.sources) ? reference.sources : []),
                providerID,
            ]),
        }))
        : [];
    return {
        status: record?.status === 'fetched' ? 'fetched' : 'unindexed',
        paperID: record?.status === 'fetched'
            ? boundedString(record?.paperID, 4_096)
            : '',
        references: record?.status === 'fetched' ? references : [],
        truncated: record?.status === 'fetched' && Boolean(record?.truncated),
        fetchedAt: Number.isFinite(record?.fetchedAt) ? record.fetchedAt : 0,
    };
}

function normalizedSources(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => boundedString(value, 64).trim().toLowerCase())
        .filter(value => /^[a-z][a-z0-9-]{0,63}$/.test(value)))]
        .sort();
}

function normalizedAuthors(values) {
    return (Array.isArray(values) ? values : []).slice(0, 100)
        .map(value => boundedString(value, 512))
        .filter(Boolean);
}

function normalizedYear(value) {
    const year = Number(value);
    return Number.isSafeInteger(year) && year >= 0 && year <= 9_999 ? year : 0;
}

function providerSupports(provider, paper) {
    try {
        return Boolean(provider.client.supports(paper));
    }
    catch {
        return false;
    }
}

function providerCacheScope(provider, papers, focus) {
    if (typeof provider?.client?.cacheScopeIdentifiers !== 'function') return [];
    const values = provider.client.cacheScopeIdentifiers(papers, focus);
    return Array.isArray(values) ? values : [];
}

function requestWarningCode(error) {
    return error?.status === 429 ? 'rate-limited' : 'request-failed';
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

async function waitForPromise(promise, signal) {
    throwIfAborted(signal);
    if (!signal) return promise;
    let relayAbort;
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
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

function sameItemID(left, right) {
    return left !== null
        && left !== undefined
        && right !== null
        && right !== undefined
        && String(left) === String(right);
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum).trim() : '';
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isSafeInteger(value)
        ? Math.max(minimum, Math.min(value, maximum))
        : fallback;
}
