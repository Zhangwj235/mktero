import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createReferenceImportService,
    createReferenceServiceActions,
} from '../src/core/reference-import-service.js';

function createLibraryHarness() {
    const matches = new Map();
    const calls = [];
    let nextItemID = 50;
    let translatedResult = null;
    let translateHook = null;
    let metadataImportHook = null;
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
            const key = reference.identifiers?.doi
                || reference.identifiers?.arxivID
                || reference.identifiers?.openAlexID;
            const value = matches.get(key) || { selectedMatches: [], otherMatches: [] };
            return {
                identifiers: reference.identifiers,
                ...value,
                ambiguous: Boolean(value.ambiguous),
                candidates: [],
                selectedMatches: value.selectedMatches.filter(
                    match => String(match.libraryID) === String(targetLibraryID)
                ),
                otherMatches: value.otherMatches.filter(
                    match => String(match.libraryID) !== String(targetLibraryID)
                ),
            };
        },
        async translateIdentifier(options) {
            calls.push(['translate']);
            if (translateHook) return translateHook(options);
            return translatedResult || { items: [{ id: nextItemID++ }], attachments: [] };
        },
        async importMetadata(options) {
            calls.push(['metadata', options]);
            if (metadataImportHook) return metadataImportHook(options);
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
        setTranslated(value) { translatedResult = value; },
        setTranslateHook(hook) { translateHook = hook; },
        setMetadataImportHook(hook) { metadataImportHook = hook; },
    };
}

test('builds tab callbacks with the current source PDF library context', async () => {
    const calls = [];
    const service = {
        async listTargetLibraries(sourceItemID, options) {
            calls.push(['libraries', sourceItemID, options]);
            return { libraries: [], defaultLibraryID: 1 };
        },
        async getStatus(reference, options) {
            calls.push(['status', reference, options]);
            return { state: 'unknown' };
        },
        async importReference(reference, options) {
            calls.push(['import', reference, options]);
            return { state: 'failed' };
        },
        async searchReferenceMetadata(reference, options) {
            calls.push(['search', reference, options]);
            return { status: 'unresolved', candidates: [] };
        },
        async openMatch(match) {
            calls.push(['open', match]);
            return match.itemID;
        },
        subscribe(listener) {
            calls.push(['subscribe', listener]);
            return () => {};
        },
    };
    let sourceItemID = 42;
    const actions = createReferenceServiceActions(service, {
        getSourceItemID: () => sourceItemID,
    });
    const signal = new AbortController().signal;
    await actions.onListReferenceLibraries({ signal });
    await actions.onListReferenceLibraries({ sourceItemID: 77, signal });
    await actions.onGetReferenceStatus({ id: 'r' }, { signal });
    await actions.onSearchReferenceMetadata({ id: 'r' }, { signal });
    await actions.onImportReference({ id: 'r' }, { signal });
    await actions.onOpenReferenceMatch({ itemID: 7 });
    actions.onSubscribeReferenceUpdates(() => {});
    sourceItemID = 99;
    await actions.onListReferenceLibraries({ signal });

    assert.equal(calls[0][1], 42);
    assert.equal(calls[0][2].signal, signal);
    assert.equal(calls[1][1], 77);
    assert.equal(calls[7][1], 99);
    assert.equal(calls[3][0], 'search');
    assert.equal(calls[3][2].signal, signal);
});

test('lists selectable libraries and rejects import into a read-only target', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({
        library,
        sourceItemID: 42,
    });
    const targets = await service.listTargetLibraries();
    assert.equal(targets.defaultLibraryID, 1);
    assert.deepEqual(targets.libraries.map(value => value.libraryID), [1, 2]);

    const result = await service.importReference({
        identifiers: { doi: '10.1000/read-only' },
    }, { targetLibraryID: 2 });
    assert.equal(result.errorCode, 'REFERENCE_LIBRARY_READ_ONLY');
    assert.equal(library.calls.some(call => call[0] === 'translate'), false);
});

test('keeps the library list available when default-library lookup fails', async () => {
    const library = createLibraryHarness();
    library.getDefaultLibraryID = async () => {
        throw new Error('source item is not available');
    };
    const service = createReferenceImportService({ library });

    const result = await service.listTargetLibraries(999);
    assert.deepEqual(result.libraries, library.libraries);
    assert.equal(result.defaultLibraryID, 1);
});

test('reports unknown for title-only references and absent for reliable misses', async () => {
    const library = createLibraryHarness();
    let externalCalls = 0;
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() {
                externalCalls++;
                return null;
            },
        },
    });
    const unknown = await service.getStatus({ text: 'A title only reference', identifiers: {} }, {
        targetLibraryID: 1,
    });
    const absent = await service.getStatus({ identifiers: { doi: '10.1000/missing' } }, {
        targetLibraryID: 1,
    });
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.canImport, false);
    const importUnknown = await service.importReference({
        text: 'A title only reference',
        identifiers: {},
    }, { targetLibraryID: 1 });
    assert.equal(importUnknown.errorCode, 'REFERENCE_IDENTIFIER_UNSUPPORTED');
    assert.equal(library.calls.some(call => call[0] === 'translate'), false);
    assert.equal(absent.state, 'absent');
    assert.equal(absent.canImport, true);
    assert.equal(externalCalls, 0);
    assert.equal((await service.getStatus({
        identifiers: { pmid: 'not-a-pmid' },
    }, { targetLibraryID: 1 })).state, 'unknown');
});

test('returns local and online metadata candidates without importing', async () => {
    const library = createLibraryHarness();
    library.find = async reference => ({
        identifiers: reference.identifiers || {},
        selectedMatches: [],
        otherMatches: [],
        ambiguous: false,
        candidates: [{
            itemID: 41,
            libraryID: 1,
            libraryName: 'Personal',
            title: 'Local title',
            year: 2024,
            hasPDF: true,
            identifiers: { doi: '10.1000/local' },
        }],
    });
    const calls = [];
    const service = createReferenceImportService({
        library,
        metadataClient: {
            now: () => 8_000,
            async searchReferences(options) {
                calls.push(options);
                return {
                    searchedAt: 8_000,
                    candidates: [{
                        source: 'openalex',
                        paperID: 'W1',
                        title: 'Online title',
                        year: 2024,
                        authors: ['Jane Doe'],
                        identifiers: {
                            doi: 'DOI:10.1000/online',
                            pdfURL: 'https://repository.example/online.pdf',
                        },
                    }],
                };
            },
        },
        getMetadataAPIKey: () => ' metadata-key ',
    });
    const result = await service.searchReferenceMetadata({
        text: 'Jane Doe. A title. 2024.',
        year: 2024,
        authorSearchText: 'jane doe',
        identifiers: {},
    }, { targetLibraryID: 1 });

    assert.equal(result.status, 'found');
    assert.deepEqual(result.localCandidates[0].identifiers, {
        doi: '10.1000/local',
        arxivID: '',
        pmid: '',
        pdfURL: '',
    });
    assert.deepEqual(result.onlineCandidates[0].identifiers, {
        doi: '10.1000/online',
        arxivID: '',
        pmid: '',
        pdfURL: 'https://repository.example/online.pdf',
    });
    assert.equal(result.candidates.length, 2);
    assert.equal(result.searchedAt, 8_000);
    assert.equal(calls[0].apiKey, 'metadata-key');
    assert.equal(library.calls.some(call => call[0] === 'translate'), false);
});

test('exposes one exact online candidate for automatic import', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({
        library,
        metadataClient: {
            async searchReferences() {
                return {
                    candidates: [{
                        source: 'openalex',
                        paperID: 'W42',
                        title: 'An exact paper',
                        year: 2024,
                        matchConfidence: 'exact',
                        identifiers: { doi: '10.1000/exact' },
                    }],
                };
            },
        },
    });

    const result = await service.searchReferenceMetadata({
        text: 'Doe. An exact paper. 2024.',
        year: 2024,
        authorSearchText: 'doe',
        identifiers: {},
    }, { targetLibraryID: 1 });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.automaticCandidate?.identifiers.doi, '10.1000/exact');
    assert.equal(result.automaticCandidate?.matchConfidence, 'exact');
});

test('keeps OpenAlex-only book metadata importable after candidate confirmation', async () => {
    const library = createLibraryHarness();
    const service = createReferenceImportService({
        library,
        metadataClient: {
            async searchReferences() {
                return {
                    searchedAt: 8_100,
                    candidates: [{
                        paperID: 'W1721908487',
                        title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
                        year: 2006,
                        authors: ['Alfred V. Aho', 'Monica S. Lam'],
                        identifiers: {
                            openAlexID: 'https://openalex.org/W1721908487',
                        },
                        metadata: {
                            itemType: 'book',
                            title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
                            year: 2006,
                            authors: ['Alfred V. Aho', 'Monica S. Lam'],
                            publisher: 'Addison-Wesley',
                        },
                    }],
                };
            },
        },
    });
    const search = await service.searchReferenceMetadata({
        text: 'Aho, A. V. Compilers: Principles, Techniques, and Tools, 2006.',
        year: 2006,
        identifiers: {},
    }, { targetLibraryID: 1 });
    const candidate = search.candidates[0];
    assert.equal(candidate.identifiers.openAlexID, 'W1721908487');
    assert.equal(candidate.metadata.itemType, 'book');

    const reference = {
        text: candidate.title,
        year: candidate.year,
        identifiers: candidate.identifiers,
        metadata: candidate.metadata,
    };
    const result = await service.importReference(reference, {
        targetLibraryID: 1,
    });
    assert.equal(result.importedItemID, 50);
    assert.equal(library.calls.some(call => call[0] === 'metadata'), true);
    assert.equal(library.calls.some(call => call[0] === 'translate'), false);
    assert.equal(library.calls.find(call => call[0] === 'metadata')[1].metadata.title,
        candidate.title);
});

test('does not perform online metadata lookup when a reliable identifier exists', async () => {
    const library = createLibraryHarness();
    let searches = 0;
    const service = createReferenceImportService({
        library,
        metadataClient: {
            async searchReferences() {
                searches++;
                return { candidates: [] };
            },
        },
    });
    const result = await service.searchReferenceMetadata({
        text: 'DOI reference',
        identifiers: { doi: '10.1000/existing' },
    }, { targetLibraryID: 1 });
    assert.equal(searches, 0);
    assert.equal(result.onlineCandidates.length, 0);
});

test('does not publish metadata candidates from an invalidated search', async () => {
    const library = createLibraryHarness();
    let resolveSearch;
    let markSearchStarted;
    const searchStarted = new Promise(resolve => {
        markSearchStarted = resolve;
    });
    const service = createReferenceImportService({
        library,
        metadataClient: {
            async searchReferences() {
                markSearchStarted();
                return new Promise(resolve => { resolveSearch = resolve; });
            },
        },
    });
    const pending = service.searchReferenceMetadata({
        text: 'stale title',
        identifiers: {},
    }, { targetLibraryID: 1 });
    await searchStarted;
    service.invalidate();
    resolveSearch({
        searchedAt: 9_000,
        candidates: [{
            title: 'Stale candidate',
            identifiers: { doi: '10.1000/stale' },
        }],
    });
    const result = await pending;
    assert.equal(result.status, 'unresolved');
    assert.deepEqual(result.candidates, []);
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

test('does not choose an ambiguous exact match and keeps retry available', async () => {
    const library = createLibraryHarness();
    library.setMatch('10.1000/ambiguous', {
        ambiguous: true,
        selectedMatches: [
            { itemID: 1, libraryID: 1, hasPDF: true },
            { itemID: 2, libraryID: 1, hasPDF: true },
        ],
        otherMatches: [],
    });
    const service = createReferenceImportService({ library });
    const result = await service.getStatus({
        identifiers: { doi: '10.1000/ambiguous' },
    }, { targetLibraryID: 1 });

    assert.equal(result.state, 'ambiguous');
    assert.equal(result.ambiguous, true);
    assert.equal(result.match, null);
    assert.equal(result.canImport, false);
    const importResult = await service.importReference({
        identifiers: { doi: '10.1000/ambiguous' },
    }, { targetLibraryID: 1 });
    assert.equal(importResult.errorCode, 'REFERENCE_DUPLICATE_RACE');
    assert.equal(importResult.canImport, true);
    assert.equal(library.calls.some(call => call[0] === 'translate'), false);
});

test('does not report imported when a duplicate appears during import', async () => {
    const library = createLibraryHarness();
    library.setTranslateHook(() => {
        library.setMatch('10.1000/race-after-import', {
            ambiguous: true,
            selectedMatches: [
                { itemID: 51, libraryID: 1, hasPDF: false },
                { itemID: 52, libraryID: 1, hasPDF: false },
            ],
            otherMatches: [],
        });
        return { items: [{ id: 51 }], attachments: [] };
    });
    const service = createReferenceImportService({ library });
    const result = await service.importReference({
        identifiers: { doi: '10.1000/race-after-import' },
    }, { targetLibraryID: 1 });

    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'REFERENCE_DUPLICATE_RACE');
    assert.equal(result.canImport, true);
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
    const events = [];
    service.subscribe(event => events.push(event.type));
    const reference = { id: 'number:1', identifiers: { doi: '10.1000/new' } };
    const [first, second] = await Promise.all([
        service.importReference(reference, { targetLibraryID: 1 }),
        service.importReference(reference, { targetLibraryID: 1 }),
    ]);
    assert.equal(first, second);
    assert.equal(library.calls.filter(call => call[0] === 'translate').length, 1);
    assert.equal(library.calls.filter(call => call[0] === 'attach').length, 1);
    assert.equal(first.state, 'imported');
    assert.ok(events.includes('updated'));
});

test('uses translator PDF attachments before trying open-access providers', async () => {
    const library = createLibraryHarness();
    library.setTranslated({
        items: [{ id: 70 }],
        attachments: [{ contentType: 'application/pdf' }],
    });
    let resolverCalls = 0;
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() {
                resolverCalls++;
                return { url: 'https://example.org/fallback.pdf' };
            },
        },
    });

    const result = await service.importReference({
        identifiers: { doi: '10.1000/translator-pdf' },
    }, { targetLibraryID: 1 });
    assert.equal(result.state, 'imported');
    assert.equal(resolverCalls, 0);
    assert.equal(library.calls.some(call => call[0] === 'attach'), false);
});

test('attaches a public arXiv PDF after metadata import', async () => {
    const library = createLibraryHarness();
    let resolvedReference;
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve(reference) {
                resolvedReference = reference;
                return {
                    url: 'https://arxiv.org/pdf/2401.00001.pdf',
                    source: 'arxiv',
                };
            },
        },
    });
    const result = await service.importReference({
        identifiers: { arxivID: '2401.00001' },
    }, { targetLibraryID: 1 });

    assert.equal(result.state, 'imported');
    assert.equal(resolvedReference.identifiers.arxivID, '2401.00001');
    assert.equal(library.calls.filter(call => call[0] === 'attach').length, 1);
});

test('keeps metadata usable when the target library cannot store files', async () => {
    const library = createLibraryHarness();
    library.libraries[0] = {
        ...library.libraries[0],
        filesEditable: false,
    };
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() {
                throw new Error('must not resolve a PDF');
            },
        },
    });
    const result = await service.importReference({
        identifiers: { doi: '10.1000/no-files' },
    }, { targetLibraryID: 1 });

    assert.equal(result.state, 'present-no-pdf');
    assert.equal(result.retryablePDF, false);
    assert.equal(library.calls.some(call => call[0] === 'attach'), false);
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

test('retries a missing PDF for an existing metadata item', async () => {
    const library = createLibraryHarness();
    library.setMatch('10.1000/retry', {
        selectedMatches: [{ itemID: 77, libraryID: 1, hasPDF: false }],
        otherMatches: [],
    });
    let resolverCalls = 0;
    const service = createReferenceImportService({
        library,
        openAccessResolver: {
            async resolve() {
                resolverCalls++;
                return { url: 'https://example.org/retry.pdf' };
            },
        },
    });
    const result = await service.retryPDF({
        identifiers: { doi: '10.1000/retry' },
    }, { targetLibraryID: 1 });

    assert.equal(result.state, 'imported');
    assert.equal(resolverCalls, 1);
    assert.equal(library.calls.filter(call => call[0] === 'translate').length, 0);
});

test('publishes refresh updates and aborts in-flight work on dispose', async () => {
    const library = createLibraryHarness();
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    library.setTranslateHook(({ signal }) => new Promise((_resolve, reject) => {
        notifyStarted();
        const abort = () => reject(
            signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })
        );
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    }));
    const service = createReferenceImportService({ library });
    const events = [];
    service.subscribe(event => events.push(event.type));
    const pending = service.importReference({
        identifiers: { doi: '10.1000/cancel' },
    }, { targetLibraryID: 1 });
    await started;
    service.dispose();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.deepEqual(events, []);
});
