import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getOpenAlexAPIKey,
    getOpenCitationsAccessToken,
    getSemanticScholarAPIKey,
    OPENALEX_API_KEY_PREF,
    OPEN_CITATIONS_ACCESS_TOKEN_PREF,
    SEMANTIC_SCHOLAR_API_KEY_PREF,
    CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH,
} from '../src/config/citation-preferences.js';

test('reads a trimmed optional Semantic Scholar API key', () => {
    const values = new Map([[SEMANTIC_SCHOLAR_API_KEY_PREF, '  secret-key  ']]);
    const zotero = { Prefs: { get: key => values.get(key) } };

    assert.equal(getSemanticScholarAPIKey(zotero), 'secret-key');
    values.set(SEMANTIC_SCHOLAR_API_KEY_PREF, '   ');
    assert.equal(getSemanticScholarAPIKey(zotero), '');
});

test('bounds malformed Semantic Scholar API key preferences', () => {
    const zotero = { Prefs: { get: () => 'x'.repeat(10_000) } };

    assert.equal(
        getSemanticScholarAPIKey(zotero).length,
        CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH
    );
    assert.equal(getSemanticScholarAPIKey({ Prefs: { get: () => null } }), '');
});

test('reads trimmed optional OpenAlex and OpenCitations credentials', () => {
    const values = new Map([
        [OPENALEX_API_KEY_PREF, ' openalex-key '],
        [OPEN_CITATIONS_ACCESS_TOKEN_PREF, ' open-citations-token '],
    ]);
    const zotero = { Prefs: { get: key => values.get(key) } };

    assert.equal(getOpenAlexAPIKey(zotero), 'openalex-key');
    assert.equal(
        getOpenCitationsAccessToken(zotero),
        'open-citations-token'
    );
    values.set(OPENALEX_API_KEY_PREF, 'x'.repeat(10_000));
    assert.equal(
        getOpenAlexAPIKey(zotero).length,
        CITATION_PROVIDER_MAX_CREDENTIAL_LENGTH
    );
});
