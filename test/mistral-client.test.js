import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MISTRAL_MAX_PDF_BYTES,
    MistralClient,
} from '../src/mistral/mistral-client.js';

test('posts a Base64 PDF with the fixed Mistral OCR profile', async () => {
    const requests = [];
    const progress = [];
    const client = new MistralClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return jsonResponse({ pages: [{ index: 0, markdown: '# Paper' }] });
        },
    });

    const result = await client.ocr({
        apiKey: ' secret-token ',
        fileName: '/private/paper.pdf',
        fileData: new Uint8Array([37, 80, 68, 70]),
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(result, { pages: [{ index: 0, markdown: '# Paper' }] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.mistral.ai/v1/ocr');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
    assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        model: 'mistral-ocr-4-1',
        document: {
            type: 'document_url',
            document_url: 'data:application/pdf;base64,JVBERg==',
        },
        include_image_base64: true,
        include_blocks: true,
        table_format: 'markdown',
    });
    assert.deepEqual(progress, [2, 5, 10, 100]);
});

test('rejects a missing API key before making a request', async () => {
    let called = false;
    const client = new MistralClient({
        fetch: async () => {
            called = true;
            return jsonResponse({ pages: [] });
        },
    });

    await assert.rejects(
        () => client.ocr({ fileData: new Uint8Array([1]) }),
        error => error.code === 'MISTRAL_API_KEY_REQUIRED'
    );
    assert.equal(called, false);
});

test('rejects a PDF larger than the service limit before Base64 encoding', async () => {
    let called = false;
    const client = new MistralClient({
        fetch: async () => {
            called = true;
            return jsonResponse({ pages: [] });
        },
        btoa: () => assert.fail('oversized input must not be encoded'),
    });

    await assert.rejects(
        () => client.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array(MISTRAL_MAX_PDF_BYTES + 1),
        }),
        error => error.code === 'MISTRAL_INPUT_TOO_LARGE'
    );
    assert.equal(called, false);
});

test('maps unauthorized responses to the stable invalid-key error without exposing the body', async () => {
    for (const status of [401, 403]) {
        const client = new MistralClient({
            fetch: async () => jsonResponse({
                error: 'secret response details',
            }, status),
            maxRetryAttempts: 3,
        });

        await assert.rejects(
            () => client.ocr({
                apiKey: 'secret-token',
                fileName: 'paper.pdf',
                fileData: new Uint8Array([1]),
            }),
            error => error.code === 'MISTRAL_API_KEY_INVALID'
                && !error.message.includes('secret')
        );
    }
});

test('retries a rate limit using a bounded Retry-After value', async () => {
    const sleeps = [];
    let attempts = 0;
    const client = new MistralClient({
        fetch: async () => {
            attempts++;
            return attempts === 1
                ? jsonResponse({ error: 'try again' }, 429, {
                    get: name => name === 'Retry-After' ? '120' : null,
                })
                : jsonResponse({ pages: [{ index: 0, markdown: '# Done' }] });
        },
        sleep: async milliseconds => sleeps.push(milliseconds),
        maxRetryAttempts: 2,
    });

    const result = await client.ocr({
        apiKey: 'secret-token',
        fileData: new Uint8Array([1]),
    });

    assert.equal(result.pages[0].markdown, '# Done');
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [60_000]);
});

test('retries only documented transient server failures', async () => {
    let attempts = 0;
    const sleeps = [];
    const client = new MistralClient({
        fetch: async () => {
            attempts++;
            return attempts < 3
                ? jsonResponse({ error: 'temporary' }, 503)
                : jsonResponse({ pages: [] });
        },
        sleep: async milliseconds => sleeps.push(milliseconds),
        retryBaseDelayMs: 7,
        maxRetryAttempts: 3,
    });

    await client.ocr({ apiKey: 'secret-token', fileData: new Uint8Array([1]) });
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [7, 14]);

    attempts = 0;
    const nonRetrying = new MistralClient({
        fetch: async () => {
            attempts++;
            return jsonResponse({ error: 'bad request' }, 422);
        },
        sleep: async () => assert.fail('422 must not be retried'),
        maxRetryAttempts: 3,
    });
    await assert.rejects(
        () => nonRetrying.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array([1]),
        }),
        error => error.code === 'MISTRAL_HTTP_ERROR' && error.status === 422
    );
    assert.equal(attempts, 1);
});

test('rejects malformed and oversized successful responses without parsing unbounded data', async () => {
    const malformed = new MistralClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode('{not-json').buffer,
        }),
    });
    await assert.rejects(
        () => malformed.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array([1]),
        }),
        error => error.code === 'MISTRAL_INVALID_RESPONSE'
    );

    const oversized = new MistralClient({
        maxResponseBytes: 8,
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: name => name === 'Content-Length' ? '9' : null },
            arrayBuffer: async () => new Uint8Array(9).buffer,
        }),
    });
    await assert.rejects(
        () => oversized.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array([1]),
        }),
        error => error.code === 'MISTRAL_RESPONSE_TOO_LARGE'
    );

    const malformedJSON = new MistralClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('malformed response');
            },
        }),
    });
    await assert.rejects(
        () => malformedJSON.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array([1]),
        }),
        error => error.code === 'MISTRAL_INVALID_RESPONSE'
    );
});

test('propagates caller cancellation as an AbortError', async () => {
    const caller = new AbortController();
    const client = new MistralClient({
        fetch: async (_url, options) => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
            });
        }),
    });
    const pending = client.ocr({
        apiKey: 'secret-token',
        fileData: new Uint8Array([1]),
        signal: caller.signal,
    });
    caller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('maps a stalled request to a timeout error', async () => {
    const client = new MistralClient({
        fetch: async (_url, options) => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
            });
        }),
        requestTimeoutMs: 5,
        maxRetryAttempts: 1,
    });

    await assert.rejects(
        () => client.ocr({
            apiKey: 'secret-token',
            fileData: new Uint8Array([1]),
        }),
        error => error.code === 'MISTRAL_REQUEST_TIMEOUT'
    );
});

function jsonResponse(body, status = 200, headers = undefined) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers,
        json: async () => body,
    };
}
