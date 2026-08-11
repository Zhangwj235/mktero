import { validateAISettings } from '../config/ai-preferences.js';
import {
    createRuntimeAbortController,
} from '../platform/abort-controller.js';

const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_INPUT_BYTES = 256 * 1024;
const MAX_CHAT_RESPONSE_BYTES = 1024 * 1024;

export class OpenAICompatibleChatClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        createAbortController = createRuntimeAbortController,
        setTimer = globalThis.setTimeout?.bind(globalThis),
        clearTimer = globalThis.clearTimeout?.bind(globalThis),
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.fetch = fetch;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
    }

    async complete({
        settings,
        messages,
        signal,
        maxOutputTokens,
    }) {
        const configuration = validateAISettings(settings);
        const normalizedMessages = validateMessages(messages);
        throwIfAborted(signal);
        const controller = this.createAbortController();
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = configuration.requestTimeoutMs > 0
            && typeof this.setTimer === 'function'
            ? this.setTimer(() => {
                timedOut = true;
                controller.abort();
            }, configuration.requestTimeoutMs)
            : null;
        try {
            const response = await this.fetch(
                `${configuration.apiBase}/chat/completions`,
                {
                    method: 'POST',
                    headers: requestHeaders(configuration.apiKey),
                    body: JSON.stringify({
                        model: configuration.model,
                        messages: normalizedMessages,
                        max_tokens: normalizeOutputTokens(
                            maxOutputTokens,
                            configuration.maxOutputTokens
                        ),
                    }),
                    signal: controller.signal,
                }
            );
            const payload = await readBoundedJSON(response);
            if (!response?.ok) throw httpError(response?.status);
            const text = responseText(payload);
            if (!text.trim()) {
                throw aiError(
                    'The AI provider returned an invalid response',
                    'AI_INVALID_RESPONSE'
                );
            }
            return {
                text,
                model: responseModel(payload.model, configuration.model),
                usage: normalizeUsage(payload.usage),
            };
        }
        catch (error) {
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isAIError(error) || isAbortError(error)) throw error;
            throw aiError('The AI provider could not be reached', 'AI_NETWORK_ERROR');
        }
        finally {
            if (timeoutID !== null && typeof this.clearTimer === 'function') {
                this.clearTimer(timeoutID);
            }
            signal?.removeEventListener('abort', relayAbort);
        }
    }
}

function validateMessages(messages) {
    if (!Array.isArray(messages)
        || !messages.length
        || messages.length > MAX_CHAT_MESSAGES) {
        throw aiError('Invalid AI chat messages', 'AI_INVALID_REQUEST');
    }
    const normalized = messages.map(message => {
        const role = String(message?.role || '');
        const content = String(message?.content || '');
        if (!['system', 'user', 'assistant'].includes(role) || !content.trim()) {
            throw aiError('Invalid AI chat messages', 'AI_INVALID_REQUEST');
        }
        return { role, content };
    });
    const bytes = new TextEncoder().encode(JSON.stringify(normalized)).length;
    if (bytes > MAX_CHAT_INPUT_BYTES) {
        throw aiError('The AI chat input is too large', 'AI_INPUT_TOO_LARGE');
    }
    return normalized;
}

function requestHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function normalizeOutputTokens(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(16_384, Math.round(number)));
}

async function readBoundedJSON(response) {
    const declaredLength = Number(response?.headers?.get?.('Content-Length'));
    if (Number.isFinite(declaredLength)
        && declaredLength > MAX_CHAT_RESPONSE_BYTES) {
        throw aiError(
            'The AI provider response is too large',
            'AI_RESPONSE_TOO_LARGE'
        );
    }
    const body = await readBoundedText(response);
    try {
        return JSON.parse(body);
    }
    catch {
        throw aiError(
            'The AI provider returned an invalid response',
            'AI_INVALID_RESPONSE'
        );
    }
}

async function readBoundedText(response) {
    const reader = response?.body?.getReader?.();
    if (!reader) throw invalidResponseError();

    const decoder = new TextDecoder();
    let body = '';
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw invalidResponseError();
            totalBytes += value.byteLength;
            if (totalBytes > MAX_CHAT_RESPONSE_BYTES) {
                await reader.cancel?.().catch?.(() => {});
                throw responseTooLargeError();
            }
            body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        return body;
    }
    catch (error) {
        if (isAIError(error)) throw error;
        throw invalidResponseError();
    }
}

function responseTooLargeError() {
    return aiError(
        'The AI provider response is too large',
        'AI_RESPONSE_TOO_LARGE'
    );
}

function invalidResponseError() {
    return aiError(
        'The AI provider returned an invalid response',
        'AI_INVALID_RESPONSE'
    );
}

function responseText(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('');
}

function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = nonNegativeInteger(usage.prompt_tokens);
    const outputTokens = nonNegativeInteger(usage.completion_tokens);
    const totalTokens = nonNegativeInteger(usage.total_tokens);
    if (inputTokens === null
        && outputTokens === null
        && totalTokens === null) {
        return null;
    }
    return { inputTokens, outputTokens, totalTokens };
}

function responseModel(value, fallback) {
    return typeof value === 'string'
        && value.trim()
        && value.length <= 512
        ? value
        : fallback;
}

function nonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function httpError(statusValue) {
    const status = Number(statusValue) || 0;
    if (status === 401 || status === 403) {
        const error = aiError('AI authentication failed', 'AI_AUTH_ERROR');
        error.status = status;
        return error;
    }
    if (status === 429) {
        const error = aiError('The AI provider rate limit was reached', 'AI_RATE_LIMITED');
        error.status = status;
        return error;
    }
    const error = aiError('The AI provider request failed', 'AI_HTTP_ERROR');
    error.status = status;
    return error;
}

function aiError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isAIError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('AI_');
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}
