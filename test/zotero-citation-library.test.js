import test from 'node:test';
import assert from 'node:assert/strict';

import { createZoteroCitationLibrary } from '../src/platform/zotero-citation-library.js';

test('lists deterministic regular-item projections from the requested library', async () => {
    const items = new Map([
        [3, regularItem(3, 'B', 2, {
            DOI: '',
            extra: 'DOI: 10.1000/B\narXiv: 2401.00002v2',
            date: '2024-02-03',
        })],
        [2, regularItem(2, 'A', 2, {
            DOI: '10.1000/A',
            date: '2023',
        })],
        [4, { id: 4, isRegularItem: () => false }],
        [5, { ...regularItem(5, 'DELETED', 2), deleted: true }],
    ]);
    const zotero = createZotero(items, [3, 2, 4, 5]);
    const adapter = createZoteroCitationLibrary(zotero);

    const papers = await adapter.listPapers(2);

    assert.equal(zotero.lastSearch.libraryID, 2);
    assert.deepEqual(papers, [{
        id: '2:A',
        itemID: 2,
        key: 'A',
        libraryID: 2,
        title: 'Title A',
        year: 2023,
        doi: '10.1000/a',
        arxivID: '',
        attachmentIDs: [102],
    }, {
        id: '2:B',
        itemID: 3,
        key: 'B',
        libraryID: 2,
        title: 'Title B',
        year: 2024,
        doi: '10.1000/b',
        arxivID: '2401.00002',
        attachmentIDs: [103],
    }]);
});

test('keeps user and group library projections isolated', async () => {
    const items = new Map([
        [1, regularItem(1, 'USER', 1)],
        [2, regularItem(2, 'GROUP', 23)],
        [3, regularItem(3, 'OTHER-GROUP', 24)],
    ]);
    const zotero = createZotero(items, [1, 2, 3]);
    const adapter = createZoteroCitationLibrary(zotero);

    const userPapers = await adapter.listPapers(1);
    const groupPapers = await adapter.listPapers(23);

    assert.deepEqual(userPapers.map(paper => paper.id), ['1:USER']);
    assert.deepEqual(groupPapers.map(paper => paper.id), ['23:GROUP']);
    assert.equal(zotero.lastSearch.libraryID, 23);
});

test('resolves regular items and attached PDFs to a graph origin', async () => {
    const parent = regularItem(7, 'PARENT', 1);
    const attached = {
        id: 42,
        libraryID: 1,
        parentItem: parent,
        isPDFAttachment: () => true,
    };
    const standalone = {
        id: 43,
        libraryID: 1,
        isPDFAttachment: () => true,
    };
    const adapter = createZoteroCitationLibrary(createZotero(new Map([
        [7, parent],
        [42, attached],
        [43, standalone],
    ])));

    assert.deepEqual(await adapter.resolveGraphOrigin(7), {
        libraryID: 1,
        itemID: 7,
    });
    assert.deepEqual(await adapter.resolveGraphOrigin(42), {
        libraryID: 1,
        itemID: 7,
    });
    await assert.rejects(
        () => adapter.resolveGraphOrigin(43),
        error => error.code === 'CITATION_PARENT_REQUIRED'
    );
});

test('opens the first PDF attachment and otherwise selects the Zotero item', async () => {
    const withPDF = regularItem(7, 'WITHPDF', 1, {}, [42, 43]);
    const withoutPDF = regularItem(8, 'WITHOUT', 1, {}, [44]);
    const items = new Map([
        [7, withPDF],
        [8, withoutPDF],
        [42, { id: 42, isPDFAttachment: () => false }],
        [43, { id: 43, isPDFAttachment: () => true }],
        [44, { id: 44, isPDFAttachment: () => false }],
    ]);
    const zotero = createZotero(items);
    const adapter = createZoteroCitationLibrary(zotero);

    assert.deepEqual(await adapter.openPaper({ itemID: 7 }), {
        kind: 'pdf',
        itemID: 43,
    });
    assert.deepEqual(zotero.readerCalls, [43]);
    assert.deepEqual(await adapter.openPaper({ itemID: 8 }), {
        kind: 'item',
        itemID: 8,
    });
    assert.deepEqual(zotero.selectCalls, [8]);
});

test('bounds unsafe fields and skips items whose field access throws', async () => {
    const unsafe = regularItem(9, 'UNSAFE', 1);
    unsafe.getField = name => {
        if (name === 'extra') throw new Error('broken field');
        if (name === 'title') return '<img src=x onerror=alert(1)>'.repeat(100);
        return '';
    };
    const adapter = createZoteroCitationLibrary(createZotero(
        new Map([[9, unsafe]]),
        [9]
    ));

    const [paper] = await adapter.listPapers(1);

    assert.equal(paper.title.length, 512);
    assert.equal(paper.doi, '');
    assert.equal(paper.arxivID, '');
});

function regularItem(id, key, libraryID, fields = {}, attachments = [id + 100]) {
    return {
        id,
        key,
        libraryID,
        deleted: false,
        isRegularItem: () => true,
        getField: name => fields[name] || (name === 'title' ? `Title ${key}` : ''),
        getDisplayTitle: () => `Title ${key}`,
        getAttachments: () => attachments,
    };
}

function createZotero(items, searchIDs = []) {
    const zotero = {
        lastSearch: null,
        readerCalls: [],
        selectCalls: [],
        Search: class Search {
            constructor() {
                zotero.lastSearch = this;
                this.conditions = [];
            }

            addCondition(...values) {
                this.conditions.push(values);
            }

            async search() {
                return searchIDs;
            }
        },
        Items: {
            get: id => items.get(id) || null,
            getAsync: async value => Array.isArray(value)
                ? value.map(id => items.get(id)).filter(Boolean)
                : items.get(value) || null,
        },
        Reader: {
            open: async id => { zotero.readerCalls.push(id); },
        },
        getMainWindow: () => ({
            ZoteroPane: {
                selectItem: async id => { zotero.selectCalls.push(id); },
            },
        }),
    };
    return zotero;
}
