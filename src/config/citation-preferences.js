export const SEMANTIC_SCHOLAR_API_KEY_PREF
    = 'extensions.mktero.semanticScholarApiKey';

export const SEMANTIC_SCHOLAR_MAX_API_KEY_LENGTH = 4_096;

export function getSemanticScholarAPIKey(zotero) {
    let value = '';
    try {
        value = zotero?.Prefs?.get?.(SEMANTIC_SCHOLAR_API_KEY_PREF, true);
    }
    catch {
        return '';
    }
    return typeof value === 'string'
        ? value.trim().slice(0, SEMANTIC_SCHOLAR_MAX_API_KEY_LENGTH)
        : '';
}
