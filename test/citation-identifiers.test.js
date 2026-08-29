import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extractCitationIdentifiers,
    normalizeArxivID,
    normalizeDOI,
    normalizeOpenAlexID,
    normalizeSemanticScholarPaper,
} from '../src/citations/citation-identifiers.js';

test('normalizes DOI URLs and rejects invalid DOI input', () => {
    assert.equal(
        normalizeDOI(' https://doi.org/10.1000/ABC.2 '),
        '10.1000/abc.2'
    );
    assert.equal(normalizeDOI('doi:10.18653/v1/N18-3011'), '10.18653/v1/n18-3011');
    assert.equal(normalizeDOI('../secret'), '');
    assert.equal(normalizeDOI('10.123/no spaces'), '');
});

test('normalizes current and legacy arXiv identifiers without versions', () => {
    assert.equal(normalizeArxivID('arXiv:2401.12345v3'), '2401.12345');
    assert.equal(
        normalizeArxivID('https://arxiv.org/pdf/hep-th/9901001v2.pdf'),
        'hep-th/9901001'
    );
    assert.equal(normalizeArxivID('not-an-arxiv-id'), '');
});

test('normalizes OpenAlex work identifiers and rejects malformed values', () => {
    assert.equal(normalizeOpenAlexID('https://openalex.org/w1721908487'), 'W1721908487');
    assert.equal(normalizeOpenAlexID(' W123 '), 'W123');
    assert.equal(normalizeOpenAlexID('W0'), '');
    assert.equal(normalizeOpenAlexID('openalex:W123'), '');
});

test('extracts DOI and arXiv from bounded Zotero metadata', () => {
    assert.deepEqual(extractCitationIdentifiers({
        doi: '',
        extra: [
            'Citation Key: example2024',
            'DOI: https://doi.org/10.1000/Example',
            'arXiv: 2401.12345v2',
        ].join('\n'),
    }), {
        doi: '10.1000/example',
        arxivID: '2401.12345',
    });
    assert.deepEqual(extractCitationIdentifiers({
        doi: '10.1000/field-wins',
        extra: 'DOI: 10.1000/extra',
    }), {
        doi: '10.1000/field-wins',
        arxivID: '',
    });
});

test('extracts an arXiv identifier before Zotero category metadata', () => {
    assert.deepEqual(extractCitationIdentifiers({
        extra: 'arXiv:2405.17766 [cs.LG]',
    }), {
        doi: '',
        arxivID: '2405.17766',
    });
});

test('does not scan identifiers beyond the Extra field budget', () => {
    assert.deepEqual(extractCitationIdentifiers({
        extra: `${'x'.repeat(16 * 1024)}\nDOI: 10.1000/hidden`,
    }), {
        doi: '',
        arxivID: '',
    });
});

test('bounds Semantic Scholar paper fields and ignores malformed records', () => {
    assert.deepEqual(normalizeSemanticScholarPaper({
        paperId: 'abc123',
        title: '  Example   paper  ',
        year: 2024,
        externalIds: {
            DOI: '10.1000/EXAMPLE',
            ArXiv: '2401.12345v2',
        },
        authors: [{ name: ' Alice  Example ' }, { name: '' }],
    }), {
        paperID: 'abc123',
        title: 'Example paper',
        year: 2024,
        doi: '10.1000/example',
        arxivID: '2401.12345',
        authors: ['Alice Example'],
    });
    assert.equal(normalizeSemanticScholarPaper({ title: 'Missing ID' }), null);
    assert.equal(normalizeSemanticScholarPaper(null), null);
});
