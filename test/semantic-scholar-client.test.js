import test from 'node:test';
import assert from 'node:assert/strict';

import { SemanticScholarClient } from '../src/citations/semantic-scholar-client.js';

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
    });
}

test('resolves DOI and arXiv identifiers in batches of at most 500', async () => {
    const requests = [];
    const client = new SemanticScholarClient({
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            return jsonResponse(body.ids.map((id, index) => ({
                paperId: `s2${requests.length}-${index}`,
                title: id,
                year: 2024,
                externalIds: id.startsWith('DOI:')
                    ? { DOI: id.slice(4) }
                    : { ArXiv: id.slice(6) },
            })));
        },
    });
    const papers = Array.from({ length: 501 }, (_, index) => ({
        id: `1:${index}`,
        doi: `10.1000/${index}`,
        arxivID: '',
    }));

    const resolved = await client.resolvePapers({
        papers,
        apiKey: ' secret-key ',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.ids.length, 500);
    assert.equal(requests[1].body.ids.length, 1);
    assert.ok(requests.flatMap(request => request.body.ids)
        .every(id => id.startsWith('DOI:')));
    assert.equal(requests[0].options.headers['x-api-key'], 'secret-key');
    assert.equal(resolved.size, 501);
    assert.equal(resolved.get('1:500').paperID, 's22-0');
});

test('falls back from a missing DOI record to arXiv without sending local IDs', async () => {
    const identifiers = [];
    const client = new SemanticScholarClient({
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            identifiers.push(...body.ids);
            return jsonResponse(body.ids.map(id => id.startsWith('ARXIV:')
                ? {
                    paperId: 's2-arxiv',
                    title: 'Resolved by arXiv',
                    externalIds: { ArXiv: id.slice(6) },
                }
                : null));
        },
    });

    const resolved = await client.resolvePapers({
        papers: [{
            id: '7:LOCAL-KEY',
            doi: '10.1000/missing',
            arxivID: '2401.12345',
        }],
    });

    assert.deepEqual(identifiers, [
        'DOI:10.1000/missing',
        'ARXIV:2401.12345',
    ]);
    assert.equal(resolved.get('7:LOCAL-KEY').paperID, 's2-arxiv');
    assert.ok(!identifiers.some(value => value.includes('LOCAL-KEY')));
});

test('fetches references by DOI then falls back to arXiv after a 404', async () => {
    const requests = [];
    const client = new SemanticScholarClient({
        fetch: async url => {
            requests.push(url);
            if (requests.length === 1) return jsonResponse({}, 404);
            return jsonResponse({
                data: [{
                    citedPaper: {
                        paperId: 'cited-1',
                        title: 'Cited paper',
                        year: 2023,
                        externalIds: { DOI: '10.1000/CITED' },
                        authors: [{ name: 'Author' }],
                    },
                }],
                next: null,
            });
        },
    });

    const result = await client.fetchReferences({
        doi: '10.1000/source',
        arxivID: '2401.00001',
    });

    assert.match(requests[0], /paper\/DOI%3A10\.1000%2Fsource\/references/);
    assert.match(requests[1], /paper\/ARXIV%3A2401\.00001\/references/);
    assert.deepEqual(result.references, [{
        paperID: 'cited-1',
        title: 'Cited paper',
        year: 2023,
        doi: '10.1000/cited',
        arxivID: '',
        authors: ['Author'],
    }]);
    assert.equal(result.status, 'fetched');
    assert.equal(result.truncated, false);
});

test('caps references at 1000 and marks a remaining page as truncated', async () => {
    const client = new SemanticScholarClient({
        fetch: async () => jsonResponse({
            data: Array.from({ length: 1001 }, (_, index) => ({
                citedPaper: {
                    paperId: `paper${index}`,
                    title: `Paper ${index}`,
                },
            })),
            next: 1000,
        }),
    });

    const result = await client.fetchReferences({ doi: '10.1000/source' });

    assert.equal(result.references.length, 1000);
    assert.equal(result.truncated, true);
});

test('retries rate limits with bounded Retry-After and does not expose secrets', async () => {
    const delays = [];
    const retries = [];
    let attempts = 0;
    const client = new SemanticScholarClient({
        fetch: async () => {
            attempts++;
            if (attempts < 3) {
                return jsonResponse({}, 429, { 'Retry-After': '2' });
            }
            return jsonResponse({ data: [], next: null });
        },
        sleep: async milliseconds => delays.push(milliseconds),
    });

    const result = await client.fetchReferences({
        doi: '10.1000/private',
        apiKey: 'private-key',
        onRetry: retry => retries.push(retry),
    });

    assert.equal(result.status, 'unindexed');
    assert.deepEqual(delays, [2_000, 2_000]);
    assert.deepEqual(retries, [{
        code: 'rate-limited',
        attempt: 1,
        retryAfterMs: 2_000,
    }, {
        code: 'rate-limited',
        attempt: 2,
        retryAfterMs: 2_000,
    }]);
    assert.equal(attempts, 3);
});

test('rejects an oversized response before parsing it', async () => {
    const client = new SemanticScholarClient({
        maxResponseBytes: 10,
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: {
                get: name => name.toLowerCase() === 'content-length'
                    ? '11'
                    : null,
            },
            arrayBuffer: async () => assert.fail('body must not be read'),
        }),
    });

    await assert.rejects(
        () => client.fetchReferences({ doi: '10.1000/source' }),
        error => error.code === 'S2_RESPONSE_TOO_LARGE'
    );
});

test('aborts a pending request through the caller signal', async () => {
    const controller = new AbortController();
    const client = new SemanticScholarClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/source',
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('aborts while a streaming response body is pending', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const client = new SemanticScholarClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader: () => ({
                    read: () => new Promise(() => {}),
                    cancel: () => { cancelled++; },
                }),
            },
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/source',
        signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(cancelled, 1);
});

test('keeps the timeout active while reading the response body', async () => {
    let timeoutCallback;
    let cancelled = 0;
    const client = new SemanticScholarClient({
        maxRetryAttempts: 1,
        setTimer(callback) {
            timeoutCallback = callback;
            return 1;
        },
        clearTimer() {},
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader: () => ({
                    read: () => new Promise(() => {}),
                    cancel: () => { cancelled++; },
                }),
            },
        }),
    });
    const pending = client.fetchReferences({ doi: '10.1000/source' });
    await Promise.resolve();
    await Promise.resolve();

    timeoutCallback();

    await assert.rejects(
        pending,
        error => error.code === 'S2_REQUEST_TIMEOUT'
    );
    assert.equal(cancelled, 1);
});
