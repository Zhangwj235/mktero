import '../platform/web-streams.js';
import { APICallError, generateText } from 'ai';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMiniMax } from '@ai-sdk/minimax';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    AI_PROTOCOL_ANTHROPIC,
    AI_PROTOCOL_GOOGLE,
    AI_PROTOCOL_OPENAI_CHAT,
    AI_PROTOCOL_OPENAI_RESPONSES,
    AI_PROTOCOL_OPEN_RESPONSES,
    AI_PROVIDER_ALIBABA,
    AI_PROVIDER_ANTHROPIC,
    AI_PROVIDER_CUSTOM,
    AI_PROVIDER_DEEPSEEK,
    AI_PROVIDER_GOOGLE,
    AI_PROVIDER_MINIMAX,
    AI_PROVIDER_MOONSHOT,
    AI_PROVIDER_OPENAI,
    validateAISettings,
} from '../config/ai-preferences.js';
import {
    createRuntimeAbortController,
} from '../platform/abort-controller.js';

const MAX_AI_MESSAGES = 100;
const MAX_AI_INPUT_BYTES = 256 * 1024;
const MAX_AI_RESPONSE_BYTES = 1024 * 1024;
const LOCAL_PROVIDER_API_KEY = 'mktero-local';

export class AISDKGateway {
    constructor({
        runtimeWindow = resolveRuntimeWindow(),
        fetch = bindRuntimeMethod(runtimeWindow, 'fetch')
            || globalThis.fetch?.bind(globalThis),
        createAbortController = createRuntimeAbortController,
        setTimer,
        clearTimer,
        generate = generateText,
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof generate !== 'function') {
            throw new TypeError('An AI SDK generateText implementation is required');
        }
        this.fetch = fetch;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer
            || bindRuntimeMethod(runtimeWindow, 'setTimeout');
        this.clearTimer = clearTimer
            || bindRuntimeMethod(runtimeWindow, 'clearTimeout');
        this.generate = generate;
    }

    async generateText({
        settings,
        messages,
        signal,
        maxOutputTokens,
    }) {
        const configuration = validateAISettings(settings);
        const prompt = validateMessages(messages);
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
            const boundedFetch = createBoundedFetch(this.fetch);
            const result = await this.generate({
                model: createLanguageModel(configuration, boundedFetch),
                messages: prompt.messages,
                ...(prompt.instructions
                    ? { instructions: prompt.instructions }
                    : {}),
                maxOutputTokens: normalizeOutputTokens(
                    maxOutputTokens,
                    configuration.maxOutputTokens
                ),
                reasoning: configuration.reasoning,
                ...reasoningProviderOptions(configuration),
                maxRetries: 0,
                abortSignal: controller.signal,
            });
            const text = String(result?.text || '');
            if (!text.trim()) {
                throw aiError(
                    'The AI provider returned an invalid response',
                    'AI_INVALID_RESPONSE'
                );
            }
            if (byteLength(text) > MAX_AI_RESPONSE_BYTES) {
                throw responseTooLargeError();
            }
            return {
                text,
                model: responseModel(result, configuration.model),
                usage: normalizeUsage(result?.usage),
            };
        }
        catch (error) {
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isAIError(error)) throw error;
            if (APICallError.isInstance(error)) throw apiCallError(error);
            if (isAbortError(error)) throw error;
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

function resolveRuntimeWindow() {
    if (typeof globalThis.window?.setTimeout === 'function') {
        return globalThis.window;
    }
    try {
        const zoteroWindow = globalThis.Zotero?.getMainWindow?.();
        if (typeof zoteroWindow?.setTimeout === 'function') {
            return zoteroWindow;
        }
    }
    catch {
        // The Zotero global may not be available during module tests or shutdown.
    }
    return globalThis;
}

function bindRuntimeMethod(runtimeWindow, method) {
    const value = runtimeWindow?.[method];
    return typeof value === 'function'
        ? value.bind(runtimeWindow)
        : undefined;
}

function reasoningProviderOptions(configuration) {
    if (configuration.provider !== AI_PROVIDER_MINIMAX
        || configuration.reasoning === 'provider-default') {
        return {};
    }
    return {
        providerOptions: {
            minimax: {
                thinking: {
                    type: configuration.reasoning === 'none'
                        ? 'disabled'
                        : 'adaptive',
                },
            },
        },
    };
}

export function createLanguageModel(configuration, fetch) {
    const providerOptions = {
        apiKey: providerApiKey(configuration),
        baseURL: configuration.apiBase,
        fetch,
    };
    switch (configuration.provider) {
        case AI_PROVIDER_OPENAI: {
            const provider = createOpenAI(providerOptions);
            return configuration.protocol === AI_PROTOCOL_OPENAI_RESPONSES
                ? provider.responses(configuration.model)
                : provider.chat(configuration.model);
        }
        case AI_PROVIDER_ANTHROPIC:
            return createAnthropic(providerOptions)(configuration.model);
        case AI_PROVIDER_GOOGLE:
            return createGoogleGenerativeAI(providerOptions)(configuration.model);
        case AI_PROVIDER_DEEPSEEK:
            return createDeepSeek(providerOptions)(configuration.model);
        case AI_PROVIDER_ALIBABA:
            return createAlibaba(providerOptions)(configuration.model);
        case AI_PROVIDER_MOONSHOT:
            return createMoonshotAI(providerOptions)(configuration.model);
        case AI_PROVIDER_MINIMAX:
            return createMiniMax(providerOptions)(configuration.model);
        case AI_PROVIDER_CUSTOM:
            return createCustomLanguageModel(configuration, fetch);
        default:
            throw aiError('The AI provider is not supported', 'AI_PROVIDER_UNSUPPORTED');
    }
}

function createCustomLanguageModel(configuration, fetch) {
    const options = {
        apiKey: providerApiKey(configuration),
        baseURL: configuration.apiBase,
        fetch,
    };
    switch (configuration.protocol) {
        case AI_PROTOCOL_OPENAI_CHAT:
            return createOpenAICompatible({
                ...options,
                name: 'mktero-compatible',
            })(configuration.model);
        case AI_PROTOCOL_OPENAI_RESPONSES:
            return createOpenAI({
                ...options,
                name: 'mktero-openai-responses',
            }).responses(configuration.model);
        case AI_PROTOCOL_OPEN_RESPONSES:
            return createOpenResponses({
                apiKey: options.apiKey,
                fetch,
                name: 'mktero-open-responses',
                url: responsesEndpoint(configuration.apiBase),
            })(configuration.model);
        case AI_PROTOCOL_ANTHROPIC:
            return createAnthropic({
                ...options,
                name: 'mktero-anthropic-compatible',
            })(configuration.model);
        case AI_PROTOCOL_GOOGLE:
            return createGoogleGenerativeAI({
                ...options,
                name: 'mktero-google-compatible',
            })(configuration.model);
        default:
            throw aiError('The AI protocol is not supported', 'AI_PROVIDER_UNSUPPORTED');
    }
}

function providerApiKey(configuration) {
    return configuration.apiKey || (isLoopbackURL(configuration.apiBase)
        ? LOCAL_PROVIDER_API_KEY
        : undefined);
}

function validateMessages(messages) {
    if (!Array.isArray(messages)
        || !messages.length
        || messages.length > MAX_AI_MESSAGES) {
        throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
    }
    const normalized = messages.map(message => {
        const role = String(message?.role || '');
        const content = String(message?.content || '');
        if (!['system', 'user', 'assistant'].includes(role) || !content.trim()) {
            throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
        }
        return { role, content };
    });
    if (byteLength(JSON.stringify(normalized)) > MAX_AI_INPUT_BYTES) {
        throw aiError('The AI input is too large', 'AI_INPUT_TOO_LARGE');
    }
    const firstNonSystem = normalized.findIndex(message => (
        message.role !== 'system'
    ));
    const systemEnd = firstNonSystem < 0 ? normalized.length : firstNonSystem;
    if (normalized.slice(systemEnd).some(message => message.role === 'system')) {
        throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
    }
    return {
        instructions: normalized
            .slice(0, systemEnd)
            .map(message => message.content)
            .join('\n\n'),
        messages: normalized.slice(systemEnd),
    };
}

function createBoundedFetch(fetch) {
    return async (input, init) => {
        const response = await fetch(input, init);
        const declaredLength = Number(response?.headers?.get?.('Content-Length'));
        if (Number.isFinite(declaredLength)
            && declaredLength > MAX_AI_RESPONSE_BYTES) {
            await response?.body?.cancel?.().catch?.(() => {});
            throw responseTooLargeError();
        }
        if (!response?.body?.getReader) return response;
        const reader = response.body.getReader();
        let totalBytes = 0;
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    if (!(value instanceof Uint8Array)) {
                        throw invalidResponseError();
                    }
                    totalBytes += value.byteLength;
                    if (totalBytes > MAX_AI_RESPONSE_BYTES) {
                        await reader.cancel?.().catch?.(() => {});
                        throw responseTooLargeError();
                    }
                    controller.enqueue(value);
                }
                catch (error) {
                    controller.error(error);
                }
            },
            cancel(reason) {
                return reader.cancel?.(reason);
            },
        });
        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

function responsesEndpoint(apiBase) {
    return apiBase.endsWith('/responses')
        ? apiBase
        : `${apiBase}/responses`;
}

function isLoopbackURL(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
                url.hostname.toLowerCase()
            );
    }
    catch {
        return false;
    }
}

function normalizeOutputTokens(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(16_384, Math.round(number)));
}

function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = nonNegativeInteger(usage.inputTokens);
    const outputTokens = nonNegativeInteger(usage.outputTokens);
    const totalTokens = nonNegativeInteger(usage.totalTokens);
    if (inputTokens === null
        && outputTokens === null
        && totalTokens === null) {
        return null;
    }
    return { inputTokens, outputTokens, totalTokens };
}

function responseModel(result, fallback) {
    const value = result?.response?.modelId || result?.finalStep?.response?.modelId;
    return typeof value === 'string'
        && value.trim()
        && value.length <= 512
        ? value
        : fallback;
}

function nonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function apiCallError(error) {
    const status = Number(error.statusCode) || 0;
    if (status === 401 || status === 403) {
        return aiStatusError('AI authentication failed', 'AI_AUTH_ERROR', status);
    }
    if (status === 429) {
        return aiStatusError(
            'The AI provider rate limit was reached',
            'AI_RATE_LIMITED',
            status
        );
    }
    return aiStatusError('The AI provider request failed', 'AI_HTTP_ERROR', status);
}

function aiStatusError(message, code, status) {
    const error = aiError(message, code);
    error.status = status;
    return error;
}

function byteLength(value) {
    return new TextEncoder().encode(String(value || '')).length;
}

function responseTooLargeError() {
    return aiError('The AI provider response is too large', 'AI_RESPONSE_TOO_LARGE');
}

function invalidResponseError() {
    return aiError('The AI provider returned an invalid response', 'AI_INVALID_RESPONSE');
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
