import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSemanticScholarAPIKey,
    SEMANTIC_SCHOLAR_API_KEY_PREF,
    SEMANTIC_SCHOLAR_MAX_API_KEY_LENGTH,
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
        SEMANTIC_SCHOLAR_MAX_API_KEY_LENGTH
    );
    assert.equal(getSemanticScholarAPIKey({ Prefs: { get: () => null } }), '');
});
