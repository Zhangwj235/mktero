export const AI_ENABLED_PREF = 'extensions.mktero.aiEnabled';
export const AI_PROVIDER_PREF = 'extensions.mktero.aiProvider';
export const AI_API_BASE_PREF = 'extensions.mktero.aiApiBase';
export const AI_API_KEY_PREF = 'extensions.mktero.aiApiKey';
export const AI_MODEL_PREF = 'extensions.mktero.aiModel';
export const AI_TARGET_LANGUAGE_PREF = 'extensions.mktero.aiTargetLanguage';
export const AI_REQUEST_TIMEOUT_PREF = 'extensions.mktero.aiRequestTimeoutMs';
export const AI_MAX_OUTPUT_TOKENS_PREF = 'extensions.mktero.aiMaxOutputTokens';
export const AI_CACHE_ENABLED_PREF = 'extensions.mktero.aiCacheEnabled';

export const AI_PROVIDER_OPENAI_COMPATIBLE = 'openai-compatible';
export const AI_DEFAULT_API_BASE = 'https://api.openai.com/v1';
export const AI_DEFAULT_TARGET_LANGUAGE = 'zh-CN';
export const AI_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

const MAX_AI_API_BASE_LENGTH = 2_048;
const MAX_AI_API_KEY_LENGTH = 16_384;
const MAX_AI_MODEL_LENGTH = 512;
const AI_TARGET_LANGUAGES = new Set([
    'zh-CN',
    'zh-TW',
    'en-US',
    'ja-JP',
    'ko-KR',
    'es-ES',
    'fr-FR',
    'pt-BR',
]);

export function getAISettings(zotero) {
    const get = key => zotero?.Prefs?.get?.(key, true);
    const apiBase = get(AI_API_BASE_PREF);
    return {
        enabled: get(AI_ENABLED_PREF) === true,
        provider: normalizeProvider(get(AI_PROVIDER_PREF)),
        apiBase: trimTrailingSlash(
            String(apiBase ?? AI_DEFAULT_API_BASE).trim()
        ),
        apiKey: String(get(AI_API_KEY_PREF) || '').trim(),
        model: String(get(AI_MODEL_PREF) || '').trim(),
        targetLanguage: normalizeTargetLanguage(
            get(AI_TARGET_LANGUAGE_PREF)
        ),
        requestTimeoutMs: normalizeInteger(
            get(AI_REQUEST_TIMEOUT_PREF),
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            120_000
        ),
        maxOutputTokens: normalizeInteger(
            get(AI_MAX_OUTPUT_TOKENS_PREF),
            AI_DEFAULT_MAX_OUTPUT_TOKENS,
            64,
            16_384
        ),
        cacheEnabled: get(AI_CACHE_ENABLED_PREF) !== false,
    };
}

export function validateAISettings(settings) {
    if (!settings?.enabled) {
        throw aiConfigurationError('AI features are disabled');
    }
    if (settings.provider !== AI_PROVIDER_OPENAI_COMPATIBLE) {
        const error = new Error('The configured AI provider is not supported');
        error.code = 'AI_PROVIDER_UNSUPPORTED';
        throw error;
    }
    const apiBase = normalizeAIBaseURL(settings.apiBase);
    const model = String(settings.model || '').trim();
    if (!model) throw aiConfigurationError('An AI model is required');
    if (model.length > MAX_AI_MODEL_LENGTH || hasControlCharacters(model)) {
        throw aiConfigurationError('The AI model is invalid');
    }
    const apiKey = String(settings.apiKey || '').trim();
    if (apiKey.length > MAX_AI_API_KEY_LENGTH || /[\r\n\0]/.test(apiKey)) {
        throw aiConfigurationError('The AI API key is invalid');
    }
    if (!apiKey && !isLoopbackURL(apiBase)) {
        throw aiConfigurationError('An AI API key is required');
    }
    return {
        ...settings,
        apiBase,
        apiKey,
        model,
        targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
        requestTimeoutMs: normalizeInteger(
            settings.requestTimeoutMs,
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            120_000
        ),
        maxOutputTokens: normalizeInteger(
            settings.maxOutputTokens,
            AI_DEFAULT_MAX_OUTPUT_TOKENS,
            64,
            16_384
        ),
    };
}

export function normalizeAIBaseURL(value) {
    const source = String(value || '').trim();
    if (!source || source.length > MAX_AI_API_BASE_LENGTH) {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    let url;
    try {
        url = new URL(source);
    }
    catch {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    const localHTTP = url.protocol === 'http:' && isLoopbackHost(url.hostname);
    if (url.protocol !== 'https:' && !localHTTP) {
        throw aiConfigurationError(
            'The AI API base URL must use HTTPS or a local HTTP address'
        );
    }
    return trimTrailingSlash(url.toString());
}

export function normalizeTargetLanguage(value) {
    const language = String(value || '').trim();
    return AI_TARGET_LANGUAGES.has(language)
        ? language
        : AI_DEFAULT_TARGET_LANGUAGE;
}

function normalizeProvider(value) {
    const provider = String(value || '').trim();
    return provider || AI_PROVIDER_OPENAI_COMPATIBLE;
}

function normalizeInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function isLoopbackURL(value) {
    try {
        return isLoopbackHost(new URL(value).hostname);
    }
    catch {
        return false;
    }
}

function isLoopbackHost(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        String(hostname || '').toLowerCase()
    );
}

function aiConfigurationError(message) {
    const error = new Error(message);
    error.code = 'AI_CONFIGURATION_ERROR';
    return error;
}

function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
