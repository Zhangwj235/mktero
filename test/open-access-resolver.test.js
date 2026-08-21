import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createOpenAccessResolver,
} from '../src/citations/open-access-resolver.js';

test('prefers a direct arXiv PDF without calling providers', async () => {
    let calls = 0;
    const resolver = createOpenAccessResolver({
        semanticScholarClient: {
            async resolveOpenAccessPDF() { calls++; return null; },
        },
    });
    const result = await resolver.resolve({
        identifiers: { arxivID: '2401.00001v2' },
    });
    assert.deepEqual(result, {
        url: 'https://arxiv.org/pdf/2401.00001.pdf',
        source: 'arxiv',
    });
    assert.equal(calls, 0);
});

test('falls back from Semantic Scholar to OpenAlex and then explicit URL', async () => {
    const calls = [];
    const resolver = createOpenAccessResolver({
        semanticScholarClient: {
            async resolveOpenAccessPDF() {
                calls.push('semantic');
                throw new Error('provider unavailable');
            },
        },
        openAlexClient: {
            async resolveOpenAccessPDF() {
                calls.push('openalex');
                return null;
            },
        },
    });
    const result = await resolver.resolve({
        identifiers: {
            doi: '10.1000/test',
            pdfURL: 'https://example.org/paper.pdf?download=1#page=1',
        },
    });
    assert.deepEqual(result, {
        url: 'https://example.org/paper.pdf?download=1',
        source: 'reference',
    });
    assert.deepEqual(calls, ['semantic', 'openalex']);
});

test('rejects unsafe provider and explicit PDF URLs', async () => {
    const resolver = createOpenAccessResolver({
        semanticScholarClient: {
            async resolveOpenAccessPDF() {
                return 'https://user:password@example.org/paper.pdf';
            },
        },
    });
    const result = await resolver.resolve({
        identifiers: {
            doi: '10.1000/test',
            pdfURL: 'javascript:alert(1)',
        },
    });
    assert.equal(result, null);
});

test('rejects loopback and private-network PDF candidates', async () => {
    const resolver = createOpenAccessResolver({
        semanticScholarClient: {
            async resolveOpenAccessPDF() {
                return 'http://192.168.1.10/paper.pdf';
            },
        },
    });
    assert.equal(await resolver.resolve({
        identifiers: {
            doi: '10.1000/test',
            pdfURL: 'http://localhost/paper.pdf',
        },
    }), null);
});

test('propagates cancellation instead of falling through', async () => {
    const controller = new AbortController();
    controller.abort();
    const resolver = createOpenAccessResolver();
    await assert.rejects(
        resolver.resolve({ identifiers: { doi: '10.1000/test' } }, {
            signal: controller.signal,
        }),
        error => error.name === 'AbortError'
    );
});

test('propagates a provider AbortError even when the signal is not marked', async () => {
    const resolver = createOpenAccessResolver({
        semanticScholarClient: {
            async resolveOpenAccessPDF() {
                throw Object.assign(new Error('aborted'), {
                    name: 'AbortError',
                });
            },
        },
    });
    await assert.rejects(
        resolver.resolve({ identifiers: { doi: '10.1000/test' } }),
        error => error.name === 'AbortError'
    );
});
