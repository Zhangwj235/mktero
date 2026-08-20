import test from 'node:test';
import assert from 'node:assert/strict';

import { CitationGraph } from '../src/citations/citation-graph.js';

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

function record(paperID, references = []) {
    return {
        status: 'fetched',
        paperID,
        references,
        truncated: false,
        fetchedAt: 1_000,
    };
}

test('returns cached graph data before refreshing a stale record', async () => {
    const papers = [paper(1, 'A'), paper(2, 'B')];
    const cached = record('s2-a', [{
        paperID: 's2-b',
        title: 'B',
        year: 2024,
        doi: '10.1000/b',
        arxivID: '',
        authors: [],
    }]);
    const fetchCalls = [];
    const progress = [];
    const graph = createGraph({
        papers,
        cached: new Map([['key-A', { record: cached, stale: true }]]),
        fetchReferences: async identifiers => {
            fetchCalls.push(identifiers);
            return { ...cached, fetchedAt: 2_000 };
        },
        resolved: new Map([
            ['1:A', { paperID: 's2-a' }],
            ['1:B', { paperID: 's2-b' }],
        ]),
    });

    const { snapshot, completion } = await graph.getLibraryGraph({
        libraryID: 1,
        focusItemID: 1,
        onProgress: value => progress.push(value),
    });

    assert.equal(snapshot.status, 'refreshing');
    assert.deepEqual(snapshot.edges, [{ source: '1:A', target: '1:B' }]);
    const final = await completion;
    assert.equal(final.status, 'complete');
    assert.equal(fetchCalls.length, 2);
    assert.equal(progress.length, 2);
});

test('does not start network refresh until the initial snapshot is returned', async () => {
    let resolveStarted = false;
    const graph = createGraph({
        papers: [paper(1, 'A')],
        resolvePapers: async () => {
            resolveStarted = true;
            return new Map();
        },
    });

    const operation = await graph.getLibraryGraph({ libraryID: 1 });

    assert.equal(resolveStarted, false);
    assert.equal(operation.snapshot.status, 'refreshing');
    await operation.completion;
    assert.equal(resolveStarted, true);
});

test('does not refresh fresh cache entries unless force refresh is requested', async () => {
    const fetchCalls = [];
    const graph = createGraph({
        papers: [paper(1, 'A')],
        cached: new Map([['key-A', {
            record: record('s2-a'),
            stale: false,
        }]]),
        fetchReferences: async values => {
            fetchCalls.push(values);
            return record('s2-a');
        },
        resolved: new Map([['1:A', { paperID: 's2-a' }]]),
    });

    const normal = await graph.getLibraryGraph({ libraryID: 1 });
    await normal.completion;
    assert.equal(fetchCalls.length, 0);

    const forced = await graph.getLibraryGraph({
        libraryID: 1,
        forceRefresh: true,
    });
    assert.equal(forced.snapshot.nodes.length, 1);
    await forced.completion;
    assert.equal(fetchCalls.length, 1);
});

test('keeps successful partial data when one paper refresh fails', async () => {
    const graph = createGraph({
        papers: [paper(1, 'A'), paper(2, 'B')],
        fetchReferences: async ({ doi }) => {
            if (doi.endsWith('/a')) throw Object.assign(new Error('offline'), {
                code: 'S2_NETWORK_ERROR',
            });
            return record('s2-b');
        },
        resolved: new Map([
            ['1:A', { paperID: 's2-a' }],
            ['1:B', { paperID: 's2-b' }],
        ]),
    });

    const operation = await graph.getLibraryGraph({ libraryID: 1 });
    const final = await operation.completion;

    assert.equal(final.status, 'partial');
    assert.deepEqual(final.progress, { completed: 2, total: 2, failed: 1 });
    assert.ok(final.warnings.some(warning => warning.code === 'request-failed'));
});

test('turns cache failures into warnings without failing the graph', async () => {
    const errors = [];
    const graph = new CitationGraph({
        library: { listPapers: async () => [paper(1, 'A')] },
        client: {
            resolvePapers: async () => new Map([['1:A', { paperID: 's2-a' }]]),
            fetchReferences: async () => record('s2-a'),
        },
        cache: {
            get: async () => { throw new Error('read'); },
            put: async () => { throw new Error('write'); },
        },
        getAPIKey: () => '',
        createCacheKey: async () => 'key-A',
        onCacheError: error => errors.push(error.message),
    });

    const operation = await graph.getLibraryGraph({ libraryID: 1 });
    const final = await operation.completion;

    assert.deepEqual(errors, ['read', 'write']);
    assert.ok(final.warnings.some(warning => warning.code === 'cache-read-failed'));
    assert.ok(final.warnings.some(warning => warning.code === 'cache-write-failed'));
});

test('stores unindexed records without a resolved canonical paper ID', async () => {
    const writes = [];
    const graph = new CitationGraph({
        library: { listPapers: async () => [paper(1, 'A')] },
        client: {
            resolvePapers: async () => new Map([['1:A', { paperID: 's2-a' }]]),
            fetchReferences: async () => ({
                status: 'unindexed',
                references: [],
                truncated: false,
                fetchedAt: 2_000,
            }),
        },
        cache: {
            get: async () => null,
            put: async (_key, value) => writes.push(value),
        },
        createCacheKey: async () => 'key-A',
    });

    const operation = await graph.getLibraryGraph({ libraryID: 1 });
    const final = await operation.completion;

    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, 'unindexed');
    assert.equal(writes[0].paperID, '');
    assert.ok(final.warnings.some(warning => (
        warning.code === 'unresolved-papers'
    )));
});

test('publishes a transient rate-limit snapshot while a retry is pending', async () => {
    const progress = [];
    const graph = new CitationGraph({
        library: { listPapers: async () => [paper(1, 'A')] },
        client: {
            async resolvePapers(options) {
                options.onRetry({
                    code: 'rate-limited',
                    attempt: 1,
                    retryAfterMs: 2_000,
                });
                return new Map();
            },
            fetchReferences: async () => record('s2-a'),
        },
        cache: {
            get: async () => null,
            put: async () => {},
        },
        createCacheKey: async () => 'key-A',
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        onProgress: snapshot => progress.push(snapshot),
    });
    await operation.completion;

    assert.ok(progress.some(snapshot => snapshot.warnings.some(warning => (
        warning.code === 'rate-limited'
        && warning.pending === true
        && warning.retryAfterMs === 2_000
    ))));
});

test('aborts remaining refresh requests through the public completion promise', async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    const graph = createGraph({
        papers: [paper(1, 'A'), paper(2, 'B')],
        fetchReferences: async ({ signal }) => {
            fetchCalls++;
            controller.abort();
            if (signal.aborted) {
                const error = new Error('aborted');
                error.name = 'AbortError';
                throw error;
            }
            return record('s2');
        },
        resolved: new Map(),
    });

    const operation = await graph.getLibraryGraph({
        libraryID: 1,
        signal: controller.signal,
    });

    await assert.rejects(operation.completion, error => error.name === 'AbortError');
    assert.equal(fetchCalls, 1);
});

function createGraph({
    papers,
    cached = new Map(),
    fetchReferences = async () => record(''),
    resolvePapers = null,
    resolved = new Map(),
}) {
    return new CitationGraph({
        library: { listPapers: async () => papers },
        client: {
            resolvePapers: resolvePapers || (async () => resolved),
            fetchReferences,
        },
        cache: {
            get: async key => cached.get(key) || null,
            put: async () => {},
        },
        getAPIKey: () => '',
        createCacheKey: async value => `key-${value.key}`,
    });
}
