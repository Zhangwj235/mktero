import { toUint8Array } from '../mineru/binary.js';
import {
    MISTRAL_OCR_MODEL_ID,
    MISTRAL_OCR_REQUEST_OPTIONS,
} from './parser-profile.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';

const DEFAULT_API_BASE = 'https://api.mistral.ai';
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_MISTRAL_PAGES = 1_000;

// Mistral's documented per-document limit. Check this before creating the
// Base64 data URL, which is substantially larger than the original PDF.
export const MISTRAL_MAX_PDF_BYTES = 50 * 1024 * 1024;

export class MistralClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        apiBase = DEFAULT_API_BASE,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        createAbortController = createRuntimeAbortController,
        setTimer = globalThis.setTimeout?.bind(globalThis),
        clearTimer = globalThis.clearTimeout?.bind(globalThis),
        now = Date.now,
        btoa = globalThis.btoa?.bind(globalThis),
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof sleep !== 'function') {
            throw new TypeError('A sleep implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
            throw new TypeError('Timer adapters are required');
        }
        if (typeof now !== 'function') {
            throw new TypeError('A clock implementation is required');
        }
        if (typeof btoa !== 'function') {
            throw new TypeError('A btoa implementation is required');
        }

        this.fetch = fetch;
        this.sleep = sleep;
        this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
        this.requestTimeoutMs = boundedInteger(
            requestTimeoutMs,
            0,
            10 * 60_000,
            DEFAULT_REQUEST_TIMEOUT_MS
        );
        this.maxRetryAttempts = boundedInteger(
            maxRetryAttempts,
            1,
            5,
            DEFAULT_MAX_RETRY_ATTEMPTS
        );
        this.retryBaseDelayMs = boundedInteger(
            retryBaseDelayMs,
            0,
            60_000,
            DEFAULT_RETRY_BASE_DELAY_MS
        );
        this.maxResponseBytes = boundedInteger(
            maxResponseBytes,
            1,
            512 * 1024 * 1024,
            DEFAULT_MAX_RESPONSE_BYTES
        );
        this.createAbortController = createAbortController;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.now = now;
        this.btoa = btoa;
    }

    async ocr({
        apiKey,
        fileName,
        fileData,
        onProgress = () => {},
        signal,
    } = {}) {
        const token = String(apiKey || '').trim();
        if (!token) {
            throw codedError(
                'A Mistral API key is required',
                'MISTRAL_API_KEY_REQUIRED'
            );
        }

        const bytes = toUint8Array(fileData, 'PDF file data');
        if (bytes.length > MISTRAL_MAX_PDF_BYTES) {
            throw codedError(
                'The PDF exceeds Mistral\'s 50 MB size limit',
                'MISTRAL_INPUT_TOO_LARGE'
            );
        }
        throwIfAborted(signal);

        notifyProgress(onProgress, CONVERSION_PROGRESS.PREPARING);
        const documentURL = `data:application/pdf;base64,${encodeBase64(
            bytes,
            this.btoa
        )}`;
        const body = JSON.stringify({
            model: MISTRAL_OCR_MODEL_ID,
            document: {
                type: 'document_url',
                document_url: documentURL,
            },
            ...MISTRAL_OCR_REQUEST_OPTIONS,
        });

        // fileName is deliberately not included in the authenticated payload:
        // the OCR endpoint only needs the data URL, and diagnostics must not
        // expose local Zotero paths or user-provided names.
        void fileName;
        const result = await this.#withRetry(
            () => this.#request({ token, body, signal, onProgress }),
            signal
        );
        notifyProgress(onProgress, CONVERSION_PROGRESS.COMPLETE);
        return result;
    }

    async #request({ token, body, signal, onProgress }) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
        if (!controller?.signal) {
            throw new TypeError('AbortController factory returned an invalid controller');
        }
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = this.requestTimeoutMs > 0
            ? this.setTimer(() => {
                timedOut = true;
                controller.abort();
            }, this.requestTimeoutMs)
            : null;

        try {
            notifyProgress(onProgress, CONVERSION_PROGRESS.UPLOADING);
            const response = await this.fetch(`${this.apiBase}/v1/ocr`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body,
                signal: controller.signal,
            });
            if (!response?.ok) throw httpError(response, this.now());
            notifyProgress(onProgress, CONVERSION_PROGRESS.PARSING);
            const payload = await readBoundedJSON(
                response,
                this.maxResponseBytes,
                controller.signal
            );
            validatePayload(payload);
            return payload;
        }
        catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (timedOut) {
                throw codedError(
                    'Mistral OCR request timed out',
                    'MISTRAL_REQUEST_TIMEOUT'
                );
            }
            if (isKnownError(error)) throw error;
            if (isAbortError(error)) {
                throw codedError(
                    'Mistral OCR request failed',
                    'MISTRAL_NETWORK_ERROR'
                );
            }
            throw codedError(
                'Mistral OCR request failed',
                'MISTRAL_NETWORK_ERROR'
            );
        }
        finally {
            if (timeoutID !== null) this.clearTimer(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
        }
    }

    async #withRetry(operation, signal) {
        for (let attempt = 0; attempt < this.maxRetryAttempts; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                const finalAttempt = attempt === this.maxRetryAttempts - 1;
                if (finalAttempt || signal?.aborted || !isRetryable(error)) {
                    throw error;
                }
                const retryAfterMs = Number.isFinite(error.retryAfterMs)
                    ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS)
                    : this.retryBaseDelayMs * (2 ** attempt);
                // A transport failure after dispatch may already have been
                // billed by the service; retries are intentionally bounded.
                await waitFor(this.sleep, retryAfterMs, signal);
            }
        }
        throw codedError(
            'Mistral OCR request failed',
            'MISTRAL_NETWORK_ERROR'
        );
    }
}

function encodeBase64(bytes, encode) {
    const chunkSize = 0x6000; // divisible by three, so chunks can be joined.
    let result = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(bytes.length, offset + chunkSize);
        let binary = '';
        for (let index = offset; index < end; index++) {
            binary += String.fromCharCode(bytes[index]);
        }
        result += encode(binary);
    }
    return result;
}

async function readBoundedJSON(response, maximum, signal) {
    const declaredLength = Number(headerValue(response, 'Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
        throw responseTooLargeError();
    }

    const reader = response?.body?.getReader?.();
    if (reader) {
        const bytes = await readBoundedStream(reader, maximum, signal);
        return parseJSONBytes(bytes);
    }
    if (typeof response?.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await withAbort(
            response.arrayBuffer(),
            signal
        ));
        if (bytes.length > maximum) throw responseTooLargeError();
        return parseJSONBytes(bytes);
    }
    if (typeof response?.text === 'function') {
        const text = await withAbort(response.text(), signal);
        if (utf8ByteLength(text) > maximum) throw responseTooLargeError();
        return parseJSONText(text);
    }
    if (typeof response?.json === 'function') {
        // Lightweight test doubles and a few older Zotero response wrappers
        // expose only json(). Keep the byte cap by measuring the serialized
        // object before accepting it.
        let payload;
        try {
            payload = await withAbort(response.json(), signal);
        }
        catch (error) {
            if (isAbortError(error)) throw error;
            throw invalidResponseError();
        }
        let serialized;
        try {
            serialized = JSON.stringify(payload);
        }
        catch {
            throw invalidResponseError();
        }
        if (typeof serialized !== 'string') throw invalidResponseError();
        if (utf8ByteLength(serialized) > maximum) {
            throw responseTooLargeError();
        }
        return payload;
    }
    throw invalidResponseError();
}

async function readBoundedStream(reader, maximum, signal) {
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await readChunk(reader, signal);
            if (done) break;
            const chunk = value instanceof Uint8Array
                ? value
                : new Uint8Array(value);
            total += chunk.length;
            if (total > maximum) {
                cancelReader(reader);
                throw responseTooLargeError();
            }
            chunks.push(chunk);
        }
    }
    catch (error) {
        cancelReader(reader);
        throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

function parseJSONBytes(bytes) {
    try {
        return parseJSONText(new TextDecoder().decode(bytes));
    }
    catch (error) {
        if (error?.code === 'MISTRAL_INVALID_RESPONSE') throw error;
        throw invalidResponseError();
    }
}

function parseJSONText(text) {
    try {
        const payload = JSON.parse(text);
        validatePayload(payload);
        return payload;
    }
    catch (error) {
        if (error?.code === 'MISTRAL_INVALID_RESPONSE') throw error;
        throw invalidResponseError();
    }
}

function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !Array.isArray(payload.pages)
        || payload.pages.length > MAX_MISTRAL_PAGES) {
        throw invalidResponseError();
    }
    return payload;
}

function httpError(response, now) {
    const status = Number(response?.status) || 0;
    if (status === 401 || status === 403) {
        const error = codedError(
            'The Mistral API key is invalid or expired',
            'MISTRAL_API_KEY_INVALID'
        );
        error.status = status;
        return error;
    }
    const error = codedError(
        `Mistral OCR returned HTTP ${status}`,
        'MISTRAL_HTTP_ERROR'
    );
    error.status = status;
    error.retryAfterMs = parseRetryAfter(
        headerValue(response, 'Retry-After'),
        now
    );
    return error;
}

function parseRetryAfter(value, now) {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    return Math.min(Math.max(0, timestamp - now), MAX_RETRY_AFTER_MS);
}

function isRetryable(error) {
    if (error?.code === 'MISTRAL_HTTP_ERROR') {
        return error.status === 429
            || error.status === 500
            || error.status === 502
            || error.status === 503
            || error.status === 504;
    }
    return error?.code === 'MISTRAL_NETWORK_ERROR'
        || error?.code === 'MISTRAL_REQUEST_TIMEOUT';
}

function isKnownError(error) {
    return typeof error?.code === 'string'
        && error.code.startsWith('MISTRAL_');
}

function notifyProgress(callback, value) {
    try {
        callback?.(value);
    }
    catch {
        // Progress callbacks cannot alter request behavior.
    }
}

function codedError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function responseTooLargeError() {
    return codedError(
        'Mistral OCR response exceeds the size limit',
        'MISTRAL_RESPONSE_TOO_LARGE'
    );
}

function invalidResponseError() {
    return codedError(
        'Mistral OCR returned an invalid response',
        'MISTRAL_INVALID_RESPONSE'
    );
}

function headerValue(response, name) {
    const headers = response?.headers;
    if (typeof headers?.get === 'function') return headers.get(name);
    if (!headers || typeof headers !== 'object') return null;
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

async function readChunk(reader, signal) {
    throwIfAborted(signal);
    if (!signal) return reader.read();
    let relayAbort;
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        return await Promise.race([reader.read(), aborted]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

async function withAbort(value, signal) {
    if (!signal) return value;
    throwIfAborted(signal);
    let relayAbort;
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        return await Promise.race([value, aborted]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

function cancelReader(reader) {
    try {
        Promise.resolve(reader?.cancel?.()).catch(() => {});
    }
    catch {
        // The request AbortController remains the authoritative cancellation.
    }
}

async function waitFor(sleep, milliseconds, signal) {
    throwIfAborted(signal);
    if (!signal) {
        await sleep(milliseconds);
        return;
    }
    let relayAbort;
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        await Promise.race([sleep(milliseconds), aborted]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
    const reason = signal?.reason;
    if (reason?.name === 'AbortError') return reason;
    const error = new Error(
        typeof reason === 'string' ? reason : 'The operation was aborted'
    );
    error.name = 'AbortError';
    if (reason !== undefined && typeof reason !== 'string') {
        error.cause = reason;
    }
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function utf8ByteLength(value) {
    return new TextEncoder().encode(value).length;
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isSafeInteger(value)
        ? Math.max(minimum, Math.min(value, maximum))
        : fallback;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
