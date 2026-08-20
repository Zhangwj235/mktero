import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCitationGraph,
    citationPaperNodeID,
} from '../src/citations/citation-graph-builder.js';

function paper(itemID, key, values = {}) {
    return {
        itemID,
        key,
        libraryID: 1,
        title: `Paper ${key}`,
        year: 2024,
        doi: '',
        arxivID: '',
        attachmentIDs: [],
        ...values,
    };
}

test('creates directed in-library edges and degree counts by DOI', () => {
    const papers = [
        paper(1, 'A', { doi: '10.1000/a' }),
        paper(2, 'B', { doi: '10.1000/b' }),
    ];
    const records = new Map([
        ['1:A', {
            paperID: 's2-a',
            references: [{
                paperID: 's2-b',
                doi: '10.1000/b',
                arxivID: '',
            }],
        }],
        ['1:B', { paperID: 's2-b', references: [] }],
    ]);

    const graph = buildCitationGraph({
        papers,
        records,
        selectedItemID: 1,
    });

    assert.deepEqual(graph.edges, [{ source: '1:A', target: '1:B' }]);
    assert.equal(graph.nodes[0].outDegree, 1);
    assert.equal(graph.nodes[0].inDegree, 0);
    assert.equal(graph.nodes[1].inDegree, 1);
    assert.equal(graph.nodes[1].degree, 1);
    assert.equal(graph.selectedItemID, 1);
});

test('falls back to DOI and arXiv identifiers when canonical IDs are unavailable', () => {
    const papers = [
        paper(1, 'A'),
        paper(2, 'B', { doi: '10.1000/b' }),
        paper(3, 'C', { arxivID: '2401.00003' }),
    ];
    const graph = buildCitationGraph({
        papers,
        records: new Map([['1:A', {
            references: [
                { paperID: '', doi: '10.1000/b', arxivID: '' },
                { paperID: '', doi: '', arxivID: '2401.00003' },
            ],
        }]]),
    });

    assert.deepEqual(graph.edges, [
        { source: '1:A', target: '1:B' },
        { source: '1:A', target: '1:C' },
    ]);
});

test('merges provider provenance when duplicate references form one edge', () => {
    const papers = [
        paper(1, 'A', { doi: '10.1000/a' }),
        paper(2, 'B', { doi: '10.1000/b' }),
    ];
    const graph = buildCitationGraph({
        papers,
        records: new Map([['1:A', {
            references: [{
                paperID: '',
                doi: '10.1000/b',
                arxivID: '',
                sources: ['semantic-scholar'],
            }, {
                paperID: '',
                doi: '10.1000/b',
                arxivID: '',
                sources: ['open-citations', 'semantic-scholar'],
            }],
        }]]),
    });

    assert.deepEqual(graph.edges, [{
        source: '1:A',
        target: '1:B',
        sources: ['open-citations', 'semantic-scholar'],
    }]);
});

test('skips ambiguous targets, self citations, provider IDs, and title matches', () => {
    const papers = [
        paper(1, 'A', { doi: '10.1000/a' }),
        paper(2, 'B', {
            doi: '10.1000/shared',
            arxivID: '2401.00002',
        }),
        paper(3, 'C', { doi: '10.1000/shared' }),
        paper(4, 'D', { title: 'Only a matching title' }),
    ];
    const graph = buildCitationGraph({
        papers,
        records: new Map([['1:A', {
            references: [
                { paperID: '', doi: '10.1000/a', arxivID: '' },
                { paperID: '', doi: '10.1000/shared', arxivID: '' },
                { paperID: '', doi: '', arxivID: '', title: 'Only a matching title' },
                { paperID: 's2-b', doi: '', arxivID: '' },
                { paperID: '', doi: '', arxivID: '2401.00002' },
                { paperID: '', doi: '', arxivID: '2401.00002' },
            ],
        }], ['1:B', { paperID: 's2-b', references: [] }]]),
    });

    assert.deepEqual(graph.edges, [{ source: '1:A', target: '1:B' }]);
    assert.ok(graph.warnings.some(warning => (
        warning.code === 'ambiguous-identifier'
        && warning.identifierType === 'doi'
    )));
});

test('keeps papers without identifiers as isolated nodes', () => {
    const papers = [paper(1, 'A')];
    const graph = buildCitationGraph({
        papers,
        records: new Map([['1:A', {
            paperID: 'provider-only-id',
            references: [],
        }]]),
    });

    assert.equal(citationPaperNodeID(papers[0]), '1:A');
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].degree, 0);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.warnings, [{
        code: 'missing-identifiers',
        count: 1,
    }]);
});

test('reports unindexed papers without removing their nodes', () => {
    const papers = [paper(1, 'A', { doi: '10.1000/a' })];
    const graph = buildCitationGraph({
        papers,
        records: new Map([['1:A', {
            status: 'unindexed',
            paperID: '',
            references: [],
        }]]),
    });

    assert.equal(graph.nodes.length, 1);
    assert.deepEqual(graph.warnings, [{
        code: 'unresolved-papers',
        count: 1,
    }]);
});
