import '../platform/web-streams.js';
import {
    APICallError,
    generateText,
    streamText as streamTextResult,
} from 'ai';
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
    AI_MAX_OUTPUT_TOKENS,
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
const DEFAULT_MAX_AI_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_AI_RESPONSE_BYTES = 1024 * 1024;
const MAX_AI_INPUT_BYTES = 4 * 1024 * 1024 + 256 * 1024;
const MAX_AI_RESPONSE_BYTES = 8 * 1024 * 1024;
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
        stream = streamTextResult,
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
        if (typeof stream !== 'function') {
            throw new TypeError('An AI SDK streamText implementation is required');
        }
        this.fetch = fetch;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer
            || bindRuntimeMethod(runtimeWindow, 'setTimeout');
        this.clearTimer = clearTimer
            || bindRuntimeMethod(runtimeWindow, 'clearTimeout');
        this.generate = generate;
        this.stream = stream;
    }

    async generateText({
        settings,
        messages,
        signal,
        maxOutputTokens,
        maxInputBytes,
        maxResponseBytes,
    }) {
        const configuration = validateAISettings(settings);
        const limits = normalizeRequestByteLimits({
            maxInputBytes,
            maxResponseBytes,
        });
        const prompt = validateMessages(messages, limits.input);
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
            const boundedFetch = createBoundedFetch(
                this.fetch,
                limits.response
            );
            const outputTokens = normalizeOutputTokens(
                maxOutputTokens,
                configuration.maxOutputTokens
            );
            const result = await this.generate({
                model: createLanguageModel(configuration, boundedFetch),
                messages: prompt.messages,
                ...(prompt.instructions
                    ? { instructions: prompt.instructions }
                    : {}),
                ...(outputTokens === null
                    ? {}
                    : { maxOutputTokens: outputTokens }),
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
            if (byteLength(text) > limits.response) {
                throw responseTooLargeError();
            }
            return {
                text,
                finishReason: normalizeFinishReason(result?.finishReason),
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

    async streamText({
        settings,
        messages,
        signal,
        maxOutputTokens,
        onTextDelta,
        maxInputBytes,
        maxResponseBytes,
    }) {
        const configuration = validateAISettings(settings);
        const limits = normalizeRequestByteLimits({
            maxInputBytes,
            maxResponseBytes,
        });
        const prompt = validateMessages(messages, limits.input);
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
            const boundedFetch = createBoundedFetch(
                this.fetch,
                limits.response
            );
            const outputTokens = normalizeOutputTokens(
                maxOutputTokens,
                configuration.maxOutputTokens
            );
            let streamError = null;
            const result = await this.stream({
                model: createLanguageModel(configuration, boundedFetch),
                messages: prompt.messages,
                ...(prompt.instructions
                    ? { instructions: prompt.instructions }
                    : {}),
                ...(outputTokens === null
                    ? {}
                    : { maxOutputTokens: outputTokens }),
                reasoning: configuration.reasoning,
                ...reasoningProviderOptions(configuration),
                maxRetries: 0,
                abortSignal: controller.signal,
                onError: ({ error }) => {
                    streamError = error;
                },
            });
            const fullStreamCandidate = result?.fullStream;
            const fullStream = fullStreamCandidate?.[Symbol.asyncIterator]
                ? fullStreamCandidate
                : null;
            const textStreamCandidate = fullStream ? null : result?.textStream;
            const textStream = fullStream
                || (textStreamCandidate?.[Symbol.asyncIterator]
                    ? textStreamCandidate
                    : null);
            if (!textStream) {
                throw invalidResponseError();
            }
            let accumulated = '';
            const responseBytes = createIncrementalByteCounter();
            let streamUsage = null;
            let streamResponse = null;
            let streamFinishReason = null;
            for await (const event of textStream) {
                if (fullStream) {
                    if (event?.type === 'error') {
                        streamError = event.error;
                        continue;
                    }
                    if (event?.type === 'finish-step'
                        || event?.type === 'finish') {
                        streamUsage = event.usage || event.totalUsage || streamUsage;
                        streamResponse = event.response || streamResponse;
                        streamFinishReason = event.finishReason
                            || streamFinishReason;
                        if (event.type === 'finish') break;
                        continue;
                    }
                }
                const chunk = fullStream
                    ? String(event?.type === 'text-delta' ? event.text || '' : '')
                    : String(event || '');
                if (!chunk) continue;
                accumulated += chunk;
                if (responseBytes.add(chunk) > limits.response) {
                    throw responseTooLargeError();
                }
                onTextDelta?.(chunk, accumulated);
            }
            if (responseBytes.finish() > limits.response) {
                throw responseTooLargeError();
            }
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            throwIfAborted(signal);
            if (streamError) throw streamError;
            const text = accumulated.trim();
            if (!text) throw invalidResponseError();
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            throwIfAborted(signal);
            const usage = fullStream
                ? streamUsage
                : result.usage ? await result.usage : null;
            const response = fullStream
                ? streamResponse
                : result.response ? await result.response : null;
            const finishReason = fullStream
                ? streamFinishReason
                : result.finishReason
                    ? await result.finishReason
                    : null;
            if (streamError) throw streamError;
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            throwIfAborted(signal);
            return {
                text,
                finishReason: normalizeFinishReason(finishReason),
                model: responseModel({ response }, configuration.model),
                usage: normalizeUsage(usage),
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

function validateMessages(messages, maxInputBytes) {
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
    if (byteLength(JSON.stringify(normalized)) > maxInputBytes) {
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

function createBoundedFetch(fetch, maxResponseBytes) {
    return async (input, init) => {
        const response = await fetch(input, init);
        const declaredLength = Number(response?.headers?.get?.('Content-Length'));
        if (Number.isFinite(declaredLength)
            && declaredLength > maxResponseBytes) {
            await response?.body?.cancel?.().catch?.(() => {});
            throw responseTooLargeError();
        }
        if (!response?.body?.getReader) return response;
        const reader = response.body.getReader();
        const sseDoneDetector = isEventStream(response)
            ? createSSEDoneDetector()
            : null;
        let totalBytes = 0;
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    if (!isByteView(value)) {
                        throw invalidResponseError();
                    }
                    totalBytes += value.byteLength;
                    if (totalBytes > maxResponseBytes) {
                        await reader.cancel?.().catch?.(() => {});
                        throw responseTooLargeError();
                    }
                    controller.enqueue(value);
                    if (sseDoneDetector?.add(value)) {
                        controller.close();
                        reader.cancel?.().catch?.(() => {});
                    }
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

function isEventStream(response) {
    return String(response?.headers?.get?.('Content-Type') || '')
        .toLowerCase()
        .startsWith('text/event-stream');
}

function createSSEDoneDetector() {
    const decoder = new TextDecoder();
    let line = '';
    let lineTooLong = false;
    let previousWasCarriageReturn = false;
    const isDoneLine = () => !lineTooLong
        && /^data:[ \t]*\[DONE\][ \t]*$/.test(line);
    const resetLine = () => {
        line = '';
        lineTooLong = false;
    };
    return {
        add(value) {
            const chunk = decoder.decode(value, { stream: true });
            for (const character of chunk) {
                if (character === '\n' && previousWasCarriageReturn) {
                    previousWasCarriageReturn = false;
                    continue;
                }
                if (character === '\r' || character === '\n') {
                    if (isDoneLine()) return true;
                    resetLine();
                    previousWasCarriageReturn = character === '\r';
                    continue;
                }
                previousWasCarriageReturn = false;
                if (lineTooLong) continue;
                if (line.length >= 64) {
                    lineTooLong = true;
                    line = '';
                    continue;
                }
                line += character;
            }
            return false;
        },
    };
}

function isByteView(value) {
    return ArrayBuffer.isView(value)
        && value.BYTES_PER_ELEMENT === 1
        && typeof value.byteLength === 'number';
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
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.max(1, Math.min(AI_MAX_OUTPUT_TOKENS, Math.round(number)));
}

function normalizeFinishReason(value) {
    const reason = String(value?.unified || value || '').trim().toLowerCase();
    return [
        'stop',
        'length',
        'content-filter',
        'tool-calls',
        'error',
        'other',
    ].includes(reason) ? reason : null;
}

function createIncrementalByteCounter() {
    let total = 0;
    let pendingHighSurrogate = '';
    return {
        add(value) {
            let chunk = pendingHighSurrogate + String(value || '');
            pendingHighSurrogate = '';
            if (/[\uD800-\uDBFF]$/.test(chunk)) {
                pendingHighSurrogate = chunk.at(-1);
                chunk = chunk.slice(0, -1);
            }
            total += byteLength(chunk);
            return total;
        },
        finish() {
            total += byteLength(pendingHighSurrogate);
            pendingHighSurrogate = '';
            return total;
        },
    };
}

function normalizeByteLimit(value, fallback, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(maximum, Math.round(number)));
}

function normalizeRequestByteLimits({ maxInputBytes, maxResponseBytes }) {
    return {
        input: normalizeByteLimit(
            maxInputBytes,
            DEFAULT_MAX_AI_INPUT_BYTES,
            MAX_AI_INPUT_BYTES
        ),
        response: normalizeByteLimit(
            maxResponseBytes,
            DEFAULT_MAX_AI_RESPONSE_BYTES,
            MAX_AI_RESPONSE_BYTES
        ),
    };
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
    if (status >= 200 && status < 300) {
        return aiStatusError(
            'The AI provider returned an invalid response',
            'AI_INVALID_RESPONSE',
            status
        );
    }
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
