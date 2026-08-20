export const SEMANTIC_SCHOLAR_API_KEY_PREF
    = 'extensions.mktero.semanticScholarApiKey';
export const OPENALEX_API_KEY_PREF = 'extensions.mktero.openAlexApiKey';
export const OPEN_CITATIONS_ACCESS_TOKEN_PREF
    = 'extensions.mktero.openCitationsAccessToken';

export const CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH = 4_096;
export const SEMANTIC_SCHOLAR_MAX_API_KEY_LENGTH
    = CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH;

export function getSemanticScholarAPIKey(zotero) {
    return getCredential(zotero, SEMANTIC_SCHOLAR_API_KEY_PREF);
}

export function getOpenAlexAPIKey(zotero) {
    return getCredential(zotero, OPENALEX_API_KEY_PREF);
}

export function getOpenCitationsAccessToken(zotero) {
    return getCredential(zotero, OPEN_CITATIONS_ACCESS_TOKEN_PREF);
}

function getCredential(zotero, preference) {
    let value = '';
    try {
        value = zotero?.Prefs?.get?.(preference, true);
    }
    catch {
        return '';
    }
    return typeof value === 'string'
        ? value.trim().slice(0, CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH)
        : '';
}
