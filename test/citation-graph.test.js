import test from 'node:test';
import assert from 'node:assert/strict';

import { CitationGraph } from '../src/citations/citation-graph.js';

test('reads and refreshes provider caches only for the focused paper', async () => {
    const papers = [paper(1, 'A'), paper(2, 'B')];
    const reads = [];
    const calls = [];
    const cached = new Map([
        ['semantic-scholar-A', {
            record: record('semantic-scholar', [reference('B')]),
            stale: true,
        }],
        ['open-citations-A', {
            record: record('open-citations', [reference('B')]),
            stale: false,
        }],
    ]);
    const graph = createGraph({
        papers,
        providers: [
            provider('semantic-scholar', async options => {
                calls.push(options);
                return record('semantic-scholar', [reference('B')], 2_000);
            }),
            provider('open-citations', async options => {
                calls.push(options);
                return record('open-citations', [], 2_000);
            }),
        ],
        cache: {
            get: async key => {
                reads.push(key);
                return cached.get(key) || null;
            },
            put: async () => {},
        },
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });

    assert.deepEqual(reads.sort(), [
        'open-citations-A',
        'semantic-scholar-A',
    ]);
    assert.deepEqual(operation.snapshot.edges, [{
        source: '1:A',
        target: '1:B',
        sources: ['open-citations', 'semantic-scholar'],
    }]);
    const final = await operation.completion;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].doi, '10.1000/a');
    assert.equal(final.status, 'complete');
});

test('starts all supported providers concurrently and publishes each result', async () => {
    const semantic = deferred();
    const openCitations = deferred();
    const openAlex = deferred();
    const calls = [];
    const progress = [];
    const graph = createGraph({
        papers: [paper(1, 'A'), paper(2, 'B'), paper(3, 'C')],
        providers: [
            provider('semantic-scholar', () => {
                calls.push('semantic-scholar');
                return semantic.promise;
            }),
            provider('open-citations', () => {
                calls.push('open-citations');
                return openCitations.promise;
            }),
            provider('openalex', () => {
                calls.push('openalex');
                return openAlex.promise;
            }),
        ],
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        onProgress: snapshot => progress.push(snapshot),
    });
    await flushTasks();

    assert.deepEqual(calls.sort(), [
        'open-citations',
        'openalex',
        'semantic-scholar',
    ]);
    openCitations.resolve(record('open-citations', [reference('B')], 2_000));
    await flushTasks();
    assert.deepEqual(progress.at(-1).edges, [{
        source: '1:A',
        target: '1:B',
        sources: ['open-citations'],
    }]);
    semantic.resolve(record('semantic-scholar', [reference('C')], 3_000));
    await flushTasks();
    openAlex.reject(Object.assign(new Error('offline'), {
        code: 'OPENALEX_NETWORK_ERROR',
    }));

    const final = await operation.completion;
    assert.equal(final.status, 'partial');
    assert.deepEqual(final.progress, { completed: 3, total: 3, failed: 1 });
    assert.deepEqual(final.edges, [{
        source: '1:A',
        target: '1:B',
        sources: ['open-citations'],
    }, {
        source: '1:A',
        target: '1:C',
        sources: ['semantic-scholar'],
    }]);
    assert.ok(final.warnings.some(warning => (
        warning.code === 'request-failed'
        && warning.providerID === 'openalex'
    )));
});

test('uses only Semantic Scholar for an arXiv-only focused paper', async () => {
    const calls = [];
    const graph = createGraph({
        papers: [paper(1, 'A', { doi: '', arxivID: '2401.12345' })],
        providers: [
            provider('semantic-scholar', async options => {
                calls.push(options.arxivID ? 'semantic-scholar' : 'unexpected');
                return record('semantic-scholar');
            }),
            provider('open-citations', async options => {
                calls.push(options.providerID);
                return record('open-citations');
            }, value => Boolean(value?.doi)),
            provider('openalex', async options => {
                calls.push(options.providerID);
                return record('openalex');
            }, value => Boolean(value?.doi)),
        ],
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    await operation.completion;

    assert.deepEqual(calls, ['semantic-scholar']);
});

test('includes provider-specific library scope in focused cache keys', async () => {
    const cacheOptions = [];
    const graph = new CitationGraph({
        library: {
            listPapers: async () => [paper(1, 'A'), paper(2, 'B')],
        },
        providers: [{
            id: 'openalex',
            getAPIKey: () => '',
            client: {
                supports: () => true,
                cacheScopeIdentifiers: () => ['doi:10.1000/b'],
                fetchReferences: async () => record('openalex'),
            },
        }],
        cache: {
            get: async () => ({
                record: record('openalex'),
                stale: false,
            }),
            put: async () => {},
        },
        createCacheKey: async (_paper, options) => {
            cacheOptions.push(options);
            return 'openalex-cache-key';
        },
        defer: async () => {},
    });

    await graph.getLibraryGraph({ libraryID: 1, focusItemID: 1 });

    assert.deepEqual(cacheOptions, [{
        providerID: 'openalex',
        scopeIdentifiers: ['doi:10.1000/b'],
    }]);
});

test('force refresh bypasses only focused provider cache freshness', async () => {
    const calls = [];
    const graph = createGraph({
        papers: [paper(1, 'A'), paper(2, 'B')],
        providers: [provider('semantic-scholar', async options => {
            calls.push(options.doi);
            return record('semantic-scholar');
        })],
        cache: {
            get: async () => ({
                record: record('semantic-scholar'),
                stale: false,
            }),
            put: async () => {},
        },
    });

    const normal = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    await normal.completion;
    assert.deepEqual(calls, []);

    const forced = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        forceRefresh: true,
    });
    await forced.completion;
    assert.deepEqual(calls, ['10.1000/a']);
});

test('turns cache failures into focused provider warnings', async () => {
    const errors = [];
    const graph = createGraph({
        papers: [paper(1, 'A')],
        providers: [provider('semantic-scholar', async () => (
            record('semantic-scholar')
        ))],
        cache: {
            get: async () => { throw new Error('read'); },
            put: async () => { throw new Error('write'); },
        },
        onCacheError: error => errors.push(error.message),
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    const final = await operation.completion;

    assert.deepEqual(errors, ['read', 'write']);
    assert.ok(final.warnings.some(warning => warning.code === 'cache-read-failed'));
    assert.ok(final.warnings.some(warning => warning.code === 'cache-write-failed'));
});

test('publishes provider retry metadata without leaking provider credentials', async () => {
    const progress = [];
    const graph = createGraph({
        papers: [paper(1, 'A')],
        providers: [provider('semantic-scholar', async options => {
            options.onRetry({
                code: 'rate-limited',
                attempt: 1,
                retryAfterMs: 2_000,
            });
            return record('semantic-scholar');
        }, () => true, () => 'private-key')],
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        onProgress: snapshot => progress.push(snapshot),
    });
    await operation.completion;

    assert.ok(progress.some(snapshot => snapshot.warnings.some(warning => (
        warning.code === 'rate-limited'
        && warning.providerID === 'semantic-scholar'
        && warning.pending === true
    ))));
    assert.doesNotMatch(JSON.stringify(progress), /private-key/);
});

test('aborts unfinished providers at the graph request deadline', async () => {
    let timeout;
    let providerSignal;
    const graph = createGraph({
        papers: [paper(1, 'A')],
        providers: [provider('semantic-scholar', options => {
            providerSignal = options.signal;
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        })],
        setTimer: callback => {
            timeout = callback;
            return 1;
        },
        clearTimer() {},
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    await flushTasks();
    timeout();
    const final = await operation.completion;

    assert.equal(providerSignal.aborted, true);
    assert.equal(final.status, 'partial');
    assert.ok(final.warnings.some(warning => (
        warning.code === 'request-timeout'
        && warning.providerID === 'semantic-scholar'
    )));
});

test('publishes fetched data before a cache write and bounds cache waiting', async () => {
    let timeout;
    const cacheWrite = deferred();
    const progress = [];
    const graph = createGraph({
        papers: [paper(1, 'A'), paper(2, 'B')],
        providers: [provider('semantic-scholar', async () => (
            record('semantic-scholar', [reference('B')])
        ))],
        cache: {
            get: async () => null,
            put: () => cacheWrite.promise,
        },
        setTimer: callback => {
            timeout = callback;
            return 1;
        },
        clearTimer() {},
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        onProgress: snapshot => progress.push(snapshot),
    });
    await flushTasks();

    assert.deepEqual(progress.at(-1).edges, [{
        source: '1:A',
        target: '1:B',
        sources: ['semantic-scholar'],
    }]);
    timeout();
    const final = await operation.completion;
    assert.equal(final.status, 'complete');
    assert.deepEqual(final.edges, progress.at(-1).edges);
});

test('propagates caller cancellation through the completion promise', async () => {
    const controller = new AbortController();
    const graph = createGraph({
        papers: [paper(1, 'A')],
        providers: [provider('semantic-scholar', options => (
            new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            })
        ))],
    });
    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        signal: controller.signal,
    });
    await flushTasks();

    controller.abort();

    await assert.rejects(operation.completion, error => error.name === 'AbortError');
});

test('opens a provider circuit after two consecutive failures', async () => {
    let calls = 0;
    let now = 1_000;
    const graph = createGraph({
        papers: [paper(1, 'A')],
        providers: [provider('openalex', async () => {
            calls++;
            throw Object.assign(new Error('offline'), {
                code: 'OPENALEX_NETWORK_ERROR',
            });
        })],
        now: () => now,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
        const operation = await graph.getLibraryGraph({
            libraryID: 1,
            focusItemID: 1,
        });
        await operation.completion;
    }
    const blocked = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    const blockedFinal = await blocked.completion;

    assert.equal(calls, 2);
    assert.ok(blockedFinal.warnings.some(warning => (
        warning.code === 'provider-circuit-open'
        && warning.providerID === 'openalex'
    )));

    now += 5 * 60 * 1_000 + 1;
    const resumed = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
    });
    await resumed.completion;
    assert.equal(calls, 3);
});

function createGraph({
    papers,
    providers,
    cache = {
        get: async () => null,
        put: async () => {},
    },
    now = () => 1_000,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    onCacheError = () => {},
}) {
    return new CitationGraph({
        library: { listPapers: async () => papers },
        providers,
        cache,
        createCacheKey: async (value, { providerID }) => (
            `${providerID}-${value.key}`
        ),
        now,
        defer: async () => {},
        setTimer,
        clearTimer,
        onCacheError,
    });
}

function provider(
    id,
    fetchReferences,
    supports = value => Boolean(value?.doi || value?.arxivID),
    getAPIKey = () => ''
) {
    return {
        id,
        getAPIKey,
        client: { supports, fetchReferences },
    };
}

function paper(itemID, key, values = {}) {
    return {
        id: `1:${key}`,
        itemID,
        key,
        libraryID: 1,
        title: key,
        year: 2024,
        doi: `10.1000/${key.toLowerCase()}`,
        arxivID: '',
        attachmentIDs: [],
        ...values,
    };
}

function record(providerID, references = [], fetchedAt = 1_000) {
    return {
        status: references.length ? 'fetched' : 'unindexed',
        paperID: '',
        references: references.map(value => ({
            ...value,
            sources: [providerID],
        })),
        truncated: false,
        fetchedAt,
    };
}

function reference(key) {
    return {
        paperID: '',
        title: key,
        year: 2024,
        doi: `10.1000/${key.toLowerCase()}`,
        arxivID: '',
        authors: [],
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushTasks() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
