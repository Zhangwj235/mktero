import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAlexClient } from '../src/citations/openalex-client.js';

test('resolves the best OpenAlex open-access PDF from a DOI-only request', async () => {
    let request;
    const client = new OpenAlexClient({
        fetch: async (url, options) => {
            request = { url: String(url), options };
            return jsonResponse({
                results: [{
                    best_oa_location: {
                        pdf_url: 'https://repository.example/paper.pdf#view=fit',
                    },
                    locations: [],
                }],
            });
        },
    });

    assert.equal(await client.resolveOpenAccessPDF({
        doi: 'DOI:10.1000/TEST',
        apiKey: 'openalex-secret',
    }), 'https://repository.example/paper.pdf');
    const parsed = new URL(request.url);
    assert.equal(parsed.searchParams.get('filter'), 'doi:10.1000/test');
    assert.match(parsed.searchParams.get('select'), /best_oa_location/);
    assert.equal(parsed.searchParams.get('api_key'), 'openalex-secret');
    assert.deepEqual(request.options.headers, {});
});

test('rejects malformed and oversized OpenAlex open-access responses', async () => {
    const malformed = new OpenAlexClient({
        fetch: async () => jsonResponse({ results: {} }),
    });
    await assert.rejects(
        () => malformed.resolveOpenAccessPDF({ doi: '10.1000/malformed' }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );

    const oversized = new OpenAlexClient({
        maxResponseBytes: 8,
        fetch: async () => jsonResponse({ results: [{ best_oa_location: {} }] }),
    });
    await assert.rejects(
        () => oversized.resolveOpenAccessPDF({ doi: '10.1000/large' }),
        error => error.code === 'OPENALEX_RESPONSE_TOO_LARGE'
    );
});

test('honors cancellation during an OpenAlex open-access lookup', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
                new DOMException('Aborted', 'AbortError')
            ), { once: true });
        }),
    });
    const pending = client.resolveOpenAccessPDF({
        doi: '10.1000/cancel',
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('matches OpenAlex references through DOI-only local paper requests', async () => {
    const requests = [];
    const client = new OpenAlexClient({
        now: () => 5_000,
        fetch: async (url, options) => {
            requests.push({ url, options });
            const parsed = new URL(url);
            const select = parsed.searchParams.get('select');
            if (select === 'id,referenced_works') {
                return jsonResponse({
                    results: [{
                        id: 'https://openalex.org/W100',
                        referenced_works: [
                            'https://openalex.org/W200',
                            'https://openalex.org/W999',
                        ],
                    }],
                });
            }
            assert.equal(select, 'id,doi');
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W200',
                    doi: 'https://doi.org/10.1000/b',
                }],
            });
        },
    });
    const papers = [
        paper(1, 'A', { doi: '10.1000/a', title: 'Private A' }),
        paper(2, 'B', { doi: '10.1000/b', title: 'Private B' }),
        paper(3, 'C', { doi: '', arxivID: '2401.12345' }),
        paper(4, 'D', { doi: '', arxivID: '' }),
    ];

    assert.equal(client.supports(papers[0]), true);
    assert.equal(client.supports(papers[2]), false);
    assert.deepEqual(client.cacheScopeIdentifiers(papers, papers[0]), [
        'doi:10.1000/b',
    ]);
    const result = await client.fetchReferences({
        doi: '10.1000/a',
        papers,
        apiKey: ' openalex-key ',
    });

    assert.deepEqual(result, {
        status: 'fetched',
        paperID: 'W100',
        references: [{
            paperID: 'W200',
            title: 'Private B',
            year: 2024,
            doi: '10.1000/b',
            arxivID: '',
            authors: [],
        }],
        truncated: false,
        fetchedAt: 5_000,
    });
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(
            new URL(request.url).searchParams.get('api_key'),
            'openalex-key'
        );
        assert.deepEqual(request.options.headers, {});
        assert.doesNotMatch(request.url, /Private|W100|W200|2401\.12345/);
        const filter = new URL(request.url).searchParams.get('filter');
        assert.match(filter, /^doi:10\.1000\//);
    }
});

test('batches DOI mappings at one hundred identifiers per request', async () => {
    const mappingFilters = [];
    const papers = Array.from({ length: 205 }, (_, index) => paper(
        index + 1,
        `P${index}`,
        { doi: `10.1000/${index}` }
    ));
    const client = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            if (parsed.searchParams.get('select') === 'id,referenced_works') {
                return jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: [],
                }] });
            }
            mappingFilters.push(parsed.searchParams.get('filter'));
            return jsonResponse({ results: [] });
        },
    });

    await client.fetchReferences({ doi: '10.1000/0', papers });

    assert.equal(mappingFilters.length, 3);
    assert.ok(mappingFilters.every(filter => filter.split('|').length <= 100));
});

test('returns a negative record when the DOI is absent from OpenAlex', async () => {
    const client = new OpenAlexClient({
        now: () => 6_000,
        fetch: async () => jsonResponse({ results: [] }),
    });

    assert.deepEqual(await client.fetchReferences({
        doi: '10.1000/missing',
        papers: [paper(1, 'A', { doi: '10.1000/missing' })],
    }), {
        status: 'unindexed',
        paperID: '',
        references: [],
        truncated: false,
        fetchedAt: 6_000,
    });
});

test('skips an OpenAlex work mapped from multiple unique local DOIs', async () => {
    const client = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            if (select === 'id,referenced_works') {
                return jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: ['W200'],
                }] });
            }
            return jsonResponse({ results: [{
                id: 'W200',
                doi: 'https://doi.org/10.1000/b',
            }, {
                id: 'W200',
                doi: 'https://doi.org/10.1000/c',
            }] });
        },
    });

    const result = await client.fetchReferences({
        doi: '10.1000/a',
        papers: [
            paper(1, 'A', { doi: '10.1000/a' }),
            paper(2, 'B', { doi: '10.1000/b' }),
            paper(3, 'C', { doi: '10.1000/c' }),
        ],
    });

    assert.equal(result.status, 'unindexed');
    assert.deepEqual(result.references, []);
});

test('rejects malformed OpenAlex work data and never accepts title lookup input', async () => {
    const client = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            return select === 'id,referenced_works'
                ? jsonResponse({ results: [{ id: 'W100', referenced_works: 'bad' }] })
                : jsonResponse({ results: [] });
        },
    });

    await assert.rejects(
        () => client.fetchReferences({
            doi: '10.1000/a',
            paper: { title: 'Do not send this title' },
            papers: [paper(1, 'A', { doi: '10.1000/a' })],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );
});

test('rejects ambiguous focus works and unsolicited DOI mappings', async () => {
    const ambiguousFocus = new OpenAlexClient({
        fetch: async () => jsonResponse({ results: [{
            id: 'W100',
            referenced_works: [],
        }, {
            id: 'W101',
            referenced_works: [],
        }] }),
    });
    await assert.rejects(
        () => ambiguousFocus.fetchReferences({
            doi: '10.1000/a',
            papers: [],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );

    const unsolicitedMapping = new OpenAlexClient({
        fetch: async url => {
            const select = new URL(url).searchParams.get('select');
            return select === 'id,referenced_works'
                ? jsonResponse({ results: [{
                    id: 'W100',
                    referenced_works: [],
                }] })
                : jsonResponse({ results: [{
                    id: 'W999',
                    doi: 'https://doi.org/10.1000/not-requested',
                }] });
        },
    });
    await assert.rejects(
        () => unsolicitedMapping.fetchReferences({
            doi: '10.1000/a',
            papers: [paper(2, 'B', { doi: '10.1000/b' })],
        }),
        error => error.code === 'OPENALEX_INVALID_RESPONSE'
    );
});

test('honors caller cancellation while OpenAlex batches are active', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/a',
        papers: [paper(1, 'A', { doi: '10.1000/a' })],
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('searches bounded OpenAlex metadata and normalizes candidate identifiers', async () => {
    let request;
    const client = new OpenAlexClient({
        now: () => 7_000,
        fetch: async (url, options) => {
            request = { url: String(url), options };
            return jsonResponse({
                results: [{
                    id: 'https://openalex.org/W123',
                    title: '  A  searchable title  ',
                    publication_year: 2024,
                    doi: 'https://doi.org/10.1000/SEARCH',
                    ids: {
                        arxiv: 'https://arxiv.org/abs/2401.12345',
                        pmid: 'https://pubmed.ncbi.nlm.nih.gov/123456/',
                    },
                    authorships: [{ author: { display_name: 'Jane Doe' } }],
                    best_oa_location: {
                        pdf_url: 'https://repository.example/paper.pdf#page=1',
                    },
                }],
            });
        },
    });

    const result = await client.searchReferences({
        text: 'Jane Doe. A searchable title. Journal. 2024.',
        year: 2024,
        authorSearchText: 'jane doe',
        apiKey: ' openalex-key ',
    });

    const parsed = new URL(request.url);
    assert.equal(parsed.searchParams.get('search'),
        'Jane Doe. A searchable title. Journal. 2024.');
    assert.equal(parsed.searchParams.get('filter'), 'publication_year:2024');
    assert.equal(parsed.searchParams.get('per-page'), null);
    assert.equal(parsed.searchParams.get('per_page'), '10');
    assert.equal(parsed.searchParams.get('api_key'), 'openalex-key');
    assert.deepEqual(result, {
        status: 'found',
        candidates: [{
            source: 'openalex',
            paperID: 'W123',
            title: 'A searchable title',
            year: 2024,
            authors: ['Jane Doe'],
            identifiers: {
                doi: '10.1000/search',
                arxivID: '2401.12345',
                pmid: '123456',
                pdfURL: 'https://repository.example/paper.pdf',
            },
        }],
        searchedAt: 7_000,
    });
    assert.deepEqual(request.options.headers, {});
});

test('caps metadata candidates and skips malformed or identifier-less works', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [
                { id: 'W1', title: 'No identifier' },
                ...Array.from({ length: 12 }, (_, index) => ({
                    id: `W${index + 2}`,
                    title: index === 0
                        ? '<script>alert(1)</script>'
                        : `Candidate ${index}`,
                    publication_year: 2023,
                    doi: `https://doi.org/10.1000/${index}`,
                })),
                { id: 'bad', title: 'Missing DOI', doi: 'not-a-doi' },
            ],
        }),
    });

    const result = await client.searchReferences({ text: 'candidate' });
    assert.equal(result.status, 'found');
    assert.equal(result.candidates.length, 10);
    assert.deepEqual(result.candidates.map(candidate => candidate.paperID),
        Array.from({ length: 10 }, (_, index) => `W${index + 2}`));
    assert.equal(result.candidates[0].title, '<script>alert(1)</script>');
});

test('honors cancellation during an explicit OpenAlex metadata search', async () => {
    const controller = new AbortController();
    const client = new OpenAlexClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
                new DOMException('Aborted', 'AbortError')
            ), { once: true });
        }),
    });
    const pending = client.searchReferences({
        text: 'cancel me',
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('does not accept arbitrary URL suffixes as PMID identifiers', async () => {
    const client = new OpenAlexClient({
        fetch: async () => jsonResponse({
            results: [{
                id: 'W700',
                title: 'Untrusted PMID',
                ids: { pmid: 'https://evil.example/700' },
            }],
        }),
    });
    const result = await client.searchReferences({ text: 'untrusted PMID' });
    assert.deepEqual(result.candidates, []);
});

function paper(itemID, key, values = {}) {
    return {
        id: `1:${key}`,
        itemID,
        key,
        libraryID: 1,
        title: key,
        year: 2024,
        doi: '',
        arxivID: '',
        attachmentIDs: [],
        ...values,
    };
}

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers });
}
