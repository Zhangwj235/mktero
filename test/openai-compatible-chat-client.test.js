import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OpenAICompatibleChatClient,
} from '../src/ai/openai-compatible-chat-client.js';

const SETTINGS = Object.freeze({
    enabled: true,
    provider: 'openai-compatible',
    apiBase: 'https://api.example.com/v1',
    apiKey: 'private-token',
    model: 'example-chat',
    requestTimeoutMs: 30_000,
    maxOutputTokens: 2_048,
});

test('calls an OpenAI-compatible chat endpoint and normalizes its result', async () => {
    let request;
    const client = new OpenAICompatibleChatClient({
        fetch: async (url, options) => {
            request = { url, options };
            return jsonResponse({
                choices: [{ message: { content: '翻译结果' } }],
                model: 'provider-model',
                usage: {
                    prompt_tokens: 12,
                    completion_tokens: 6,
                    total_tokens: 18,
                },
            });
        },
    });

    const result = await client.complete({
        settings: SETTINGS,
        messages: [
            { role: 'system', content: 'Translate.' },
            { role: 'user', content: 'Source text' },
        ],
    });

    assert.equal(request.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer private-token');
    assert.deepEqual(JSON.parse(request.options.body), {
        model: 'example-chat',
        messages: [
            { role: 'system', content: 'Translate.' },
            { role: 'user', content: 'Source text' },
        ],
        max_tokens: 2048,
    });
    assert.deepEqual(result, {
        text: '翻译结果',
        model: 'provider-model',
        usage: {
            inputTokens: 12,
            outputTokens: 6,
            totalTokens: 18,
        },
    });
});

test('does not send an authorization header to a local server without a key', async () => {
    let headers;
    const client = new OpenAICompatibleChatClient({
        fetch: async (_url, options) => {
            headers = options.headers;
            return jsonResponse({
                choices: [{ message: { content: 'OK' } }],
            });
        },
    });
    await client.complete({
        settings: {
            ...SETTINGS,
            apiBase: 'http://localhost:11434/v1',
            apiKey: '',
        },
        messages: [{ role: 'user', content: 'Test' }],
    });

    assert.equal('Authorization' in headers, false);
});

test('maps authentication, rate limit, and malformed responses safely', async () => {
    for (const [status, code] of [
        [401, 'AI_AUTH_ERROR'],
        [429, 'AI_RATE_LIMITED'],
        [500, 'AI_HTTP_ERROR'],
    ]) {
        const client = new OpenAICompatibleChatClient({
            fetch: async () => jsonResponse(
                { error: { message: 'provider secret response' } },
                { status }
            ),
        });
        await assert.rejects(
            client.complete({
                settings: SETTINGS,
                messages: [{ role: 'user', content: 'Test' }],
            }),
            error => {
                assert.equal(error.code, code);
                assert.doesNotMatch(error.message, /secret response/);
                assert.doesNotMatch(error.message, /private-token/);
                return true;
            }
        );
    }

    const malformed = new OpenAICompatibleChatClient({
        fetch: async () => jsonResponse({ choices: [] }),
    });
    await assert.rejects(
        malformed.complete({
            settings: SETTINGS,
            messages: [{ role: 'user', content: 'Test' }],
        }),
        error => error?.code === 'AI_INVALID_RESPONSE'
    );
});

test('relays cancellation to the Chat request', async () => {
    const controller = new AbortController();
    const client = new OpenAICompatibleChatClient({
        fetch: async (_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
            });
        }),
    });
    const pending = client.complete({
        settings: SETTINGS,
        messages: [{ role: 'user', content: 'Test' }],
        signal: controller.signal,
    });
    controller.abort(new Error('caller cancelled'));

    await assert.rejects(pending, /caller cancelled/);
});

test('maps the configured request deadline without exposing provider details', async () => {
    let timeout;
    let cleared;
    const client = new OpenAICompatibleChatClient({
        fetch: async (_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                reject(new Error('provider timeout details'));
            }, { once: true });
        }),
        setTimer(callback) {
            timeout = callback;
            return 7;
        },
        clearTimer(timerID) { cleared = timerID; },
    });
    const pending = client.complete({
        settings: SETTINGS,
        messages: [{ role: 'user', content: 'Test' }],
    });

    timeout();

    await assert.rejects(pending, error => {
        assert.equal(error.code, 'AI_REQUEST_TIMEOUT');
        assert.doesNotMatch(error.message, /provider timeout details/);
        return true;
    });
    assert.equal(cleared, 7);
});

test('stops reading a streamed response at the response budget', async () => {
    const chunks = [
        new Uint8Array(600 * 1024),
        new Uint8Array(600 * 1024),
    ];
    let canceled = false;
    const client = new OpenAICompatibleChatClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader() {
                    return {
                        async read() {
                            const value = chunks.shift();
                            return value ? { done: false, value } : { done: true };
                        },
                        async cancel() { canceled = true; },
                    };
                },
            },
        }),
    });

    await assert.rejects(
        client.complete({
            settings: SETTINGS,
            messages: [{ role: 'user', content: 'Test' }],
        }),
        error => error?.code === 'AI_RESPONSE_TOO_LARGE'
    );
    assert.equal(canceled, true);
});

test('rejects a response that cannot be read within a bounded stream', async () => {
    let textRead = false;
    const client = new OpenAICompatibleChatClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => {
                textRead = true;
                return JSON.stringify({
                    choices: [{ message: { content: 'unsafe fallback' } }],
                });
            },
        }),
    });

    await assert.rejects(
        client.complete({
            settings: SETTINGS,
            messages: [{ role: 'user', content: 'Test' }],
        }),
        error => error?.code === 'AI_INVALID_RESPONSE'
    );
    assert.equal(textRead, false);
});

function jsonResponse(payload, { status = 200 } = {}) {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    let sent = false;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return name.toLowerCase() === 'content-length'
                    ? String(body.byteLength)
                    : null;
            },
        },
        body: {
            getReader() {
                return {
                    async read() {
                        if (sent) return { done: true };
                        sent = true;
                        return { done: false, value: body };
                    },
                };
            },
        },
    };
}
