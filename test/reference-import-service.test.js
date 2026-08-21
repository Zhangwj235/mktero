import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createReferenceImportService,
} from '../src/core/reference-import-service.js';

function createLibraryHarness() {
    const matches = new Map();
    const calls = [];
    let nextItemID = 50;
    const libraries = [
        { libraryID: 1, name: 'Personal', type: 'user', editable: true, filesEditable: true },
        { libraryID: 2, name: 'Read-only', type: 'group', editable: false, filesEditable: false },
    ];
    return {
        calls,
        libraries,
        async listLibraries() { return libraries; },
        async getDefaultLibraryID() { return 1; },
        invalidate() { calls.push(['invalidate']); },
        async refreshIndex() { calls.push(['refresh']); },
        async find(reference, { targetLibraryID }) {
            const key = reference.identifiers?.doi || reference.identifiers?.arxivID;
            const value = matches.get(key) || { selectedMatches: [], otherMatches: [] };
            return {
                identifiers: reference.identifiers,
                ...value,
                candidates: [],
                selectedMatches: value.selectedMatches.filter(
                    match => String(match.libraryID) === String(targetLibraryID)
                ),
                otherMatches: value.otherMatches.filter(
                    match => String(match.libraryID) !== String(targetLibraryID)
                ),
            };
        },
        async translateIdentifier() {
            calls.push(['translate']);
            return { items: [{ id: nextItemID++ }], attachments: [] };
        },
        async attachPDF(options) {
            calls.push(['attach', options]);
            return { id: nextItemID++ };
        },
        async copyItem(options) {
            calls.push(['copy', options]);
            return nextItemID++;
        },
        async openItem(id) {
            calls.push(['open', id]);
            return id;
        },
        setMatch(key, value) { matches.set(key, value); },
    };
}

test('reports unknown for title-only references and absent for reliable misses', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({ library });
    const unknown = await service.getStatus({ text: 'A title only reference', identifiers: {} }, {
        targetLibraryID: 1,
    });
    const absent = await service.getStatus({ identifiers: { doi: '10.1000/missing' } }, {
        targetLibraryID: 1,
    });
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.canImport, false);
    assert.equal(absent.state, 'absent');
    assert.equal(absent.canImport, true);
    assert.equal((await service.getStatus({
        identifiers: { pmid: 'not-a-pmid' },
    }, { targetLibraryID: 1 })).state, 'unknown');
});

test('reports selected, other-library, and no-PDF states', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({ library });
    library.setMatch('10.1000/present', {
        selectedMatches: [{ itemID: 1, libraryID: 1, hasPDF: true }],
        otherMatches: [],
    });
    library.setMatch('10.1000/nopdf', {
        selectedMatches: [{ itemID: 2, libraryID: 1, hasPDF: false }],
        otherMatches: [],
    });
    library.setMatch('10.1000/other', {
        selectedMatches: [],
        otherMatches: [{ itemID: 3, libraryID: 2, hasPDF: true }],
    });
    assert.equal((await service.getStatus({ identifiers: { doi: '10.1000/present' } }, { targetLibraryID: 1 })).state, 'present');
    assert.equal((await service.getStatus({ identifiers: { doi: '10.1000/nopdf' } }, { targetLibraryID: 1 })).state, 'present-no-pdf');
    assert.equal((await service.getStatus({ identifiers: { doi: '10.1000/other' } }, { targetLibraryID: 1 })).state, 'present-other-library');
});

test('deduplicates imports and attaches an open PDF after metadata', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() {
                return { url: 'https://example.org/paper.pdf', source: 'test' };
            },
        },
    });
    const reference = { id: 'number:1', identifiers: { doi: '10.1000/new' } };
    const [first, second] = await Promise.all([
        service.importReference(reference, { targetLibraryID: 1 }),
        service.importReference(reference, { targetLibraryID: 1 }),
    ]);
    assert.equal(first, second);
    assert.equal(library.calls.filter(call => call[0] === 'translate').length, 1);
    assert.equal(library.calls.filter(call => call[0] === 'attach').length, 1);
    assert.equal(first.state, 'imported');
});

test('copies an existing item from another library instead of silently duplicating it', async () => {
    const library = createLibraryHarness();
    library.setMatch('10.1000/other', {
        selectedMatches: [],
        otherMatches: [{ itemID: 3, libraryID: 2, hasPDF: false }],
    });
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() { return null; },
        },
    });
    const result = await service.importReference({
        identifiers: { doi: '10.1000/other' },
    }, { targetLibraryID: 1 });
    assert.equal(result.state, 'present-no-pdf');
    assert.equal(library.calls.filter(call => call[0] === 'copy').length, 1);
    assert.equal(library.calls.filter(call => call[0] === 'translate').length, 0);
});

test('preserves metadata when PDF resolution fails and exposes retry state', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() { throw Object.assign(new Error(), { code: 'REFERENCE_NETWORK_FAILED' }); },
        },
    });
    const result = await service.importReference({
        identifiers: { doi: '10.1000/pdf-fails' },
    }, { targetLibraryID: 1 });
    assert.equal(result.state, 'present-no-pdf');
    assert.equal(result.retryablePDF, true);
    assert.equal(result.pdfError, 'REFERENCE_NETWORK_FAILED');
});
