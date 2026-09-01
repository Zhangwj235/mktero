export const CONVERSION_PROVIDER_MINERU = 'mineru';
export const CONVERSION_PROVIDER_MISTRAL = 'mistral';

export const CONVERSION_PROVIDER_PREF =
    'extensions.mktero.conversionProvider';
export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MISTRAL_API_KEY_PREF = 'extensions.mktero.mistralApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';

const SUPPORTED_CONVERSION_PROVIDERS = new Set([
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
]);

export function normalizeConversionProvider(value) {
    const provider = String(value || '').trim();
    return SUPPORTED_CONVERSION_PROVIDERS.has(provider)
        ? provider
        : CONVERSION_PROVIDER_MINERU;
}

export function getConversionProvider(zotero) {
    return normalizeConversionProvider(
        zotero?.Prefs?.get?.(CONVERSION_PROVIDER_PREF, true)
    );
}

export function getMinerUApiKey(zotero) {
    return readPreferenceString(zotero, MINERU_API_KEY_PREF);
}

export function getMistralApiKey(zotero) {
    return readPreferenceString(zotero, MISTRAL_API_KEY_PREF);
}

export function getMinerUCacheEnabled(zotero) {
    return zotero?.Prefs?.get?.(MINERU_CACHE_ENABLED_PREF, true) !== false;
}

function readPreferenceString(zotero, key) {
    return String(zotero?.Prefs?.get?.(key, true) || '').trim();
}
