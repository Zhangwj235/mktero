import test from 'node:test';
import assert from 'node:assert/strict';

import {
    scopeCitationGraphSnapshot,
} from '../src/citations/citation-graph-scope.js';

function snapshot() {
    return {
        libraryID: 1,
        libraryName: 'My Library',
        nodes: [
            node(7, '1:A', 'A', { doi: '10.1000/a', paperID: 's2-a' }),
            node(8, '1:B', 'B', { doi: '10.1000/b', paperID: 's2-b' }),
            node(9, '1:C', 'C', { doi: '10.1000/c', paperID: 's2-c' }),
        ],
        edges: [
            { source: '1:A', target: '1:B' },
            { source: '1:C', target: '1:A' },
        ],
        selectedItemID: 7,
        status: 'complete',
        progress: { completed: 3, total: 3, failed: 0 },
        warnings: [
            { code: 'request-failed', itemID: 9 },
            { code: 'missing-identifiers', count: 1 },
        ],
    };
}

function node(itemID, id, title, values = {}) {
    return {
        itemID,
        id,
        title,
        year: 2024,
        doi: '',
        arxivID: '',
        paperID: '',
        inDegree: 0,
        outDegree: 0,
        degree: 0,
        ...values,
    };
}

test('keeps only the current paper and its direct in-library references', () => {
    const scoped = scopeCitationGraphSnapshot(snapshot(), 7);

    assert.deepEqual(scoped.nodes.map(node => node.itemID), [7, 8]);
    assert.deepEqual(scoped.edges, [{ source: '1:A', target: '1:B' }]);
    assert.equal(scoped.nodes[0].outDegree, 1);
    assert.equal(scoped.nodes[0].inDegree, 0);
    assert.equal(scoped.nodes[1].inDegree, 1);
    assert.equal(scoped.nodes[1].outDegree, 0);
    assert.deepEqual(scoped.warnings, []);
});

test('returns an empty local graph when the current paper is unavailable', () => {
    const scoped = scopeCitationGraphSnapshot(snapshot(), 99);

    assert.deepEqual(scoped.nodes, []);
    assert.deepEqual(scoped.edges, []);
    assert.equal(scoped.selectedItemID, null);
});
