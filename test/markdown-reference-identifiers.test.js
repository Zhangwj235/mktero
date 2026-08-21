import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractReferenceIdentifiers,
} from '../src/markdown/markdown-reference-identifiers.js';

test('extracts normalized DOI, arXiv, explicit PMID, and PDF URL', () => {
    assert.deepEqual(
        extractReferenceIdentifiers(
            'Doe. Paper title. doi:10.1000/ABC. PMID: 12345678. '
            + 'https://arxiv.org/abs/2401.00001v2 '
            + 'https://example.org/papers/paper.pdf#page=2'
        ),
        {
            doi: '10.1000/abc',
            arxivID: '2401.00001',
            pmid: '12345678',
            pdfURL: 'https://example.org/papers/paper.pdf',
        }
    );
});

test('does not infer PMID from ordinary citation numbers', () => {
    assert.equal(
        extractReferenceIdentifiers(
            'The sample size was [1, 2] in 2020 and pages 123-129.'
        ).pmid,
        ''
    );
});

test('rejects non-PDF and unsafe URL candidates', () => {
    assert.equal(
        extractReferenceIdentifiers(
            'javascript:alert(1) https://example.org/article.html '
            + 'https://example.org/file.pdf?download=1'
        ).pdfURL,
        'https://example.org/file.pdf?download=1'
    );
    assert.equal(
        extractReferenceIdentifiers(
            'https://example.org/download?format=pdf#page=2'
        ).pdfURL,
        'https://example.org/download?format=pdf'
    );
});

test('bounds input and returns stable empty fields', () => {
    assert.deepEqual(extractReferenceIdentifiers('x'.repeat(20_000)), {
        doi: '',
        arxivID: '',
        pmid: '',
        pdfURL: '',
    });
});
