import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroReferenceLibrary,
} from '../src/platform/zotero-reference-library.js';

function item({
    id,
    libraryID,
    title,
    DOI = '',
    PMID = '',
    extra = '',
    attachments = [],
    creators = [],
    deleted = false,
} = {}) {
    return {
        id,
        libraryID,
        key: `KEY-${id}`,
        deleted,
        isRegularItem: () => true,
        getField(name) {
            return {
                title,
                DOI,
                PMID,
                extra,
                year: '2024',
                date: '2024',
            }[name] || '';
        },
        getAttachments: () => attachments,
        getCreators: () => creators,
        inTrash: () => false,
    };
}

function createRuntime(items) {
    const byID = new Map(items.map(value => [value.id, value]));
    return {
        Libraries: {
            userLibraryID: 1,
            getAll: () => [
                {
                    libraryID: 2,
                    name: 'Read-only Group',
                    libraryType: 'group',
                    editable: false,
                    filesEditable: false,
                },
                {
                    libraryID: 1,
                    name: 'Personal',
                    libraryType: 'user',
                    editable: true,
                    filesEditable: true,
                },
                { libraryID: 3, name: 'Feed', libraryType: 'feed' },
            ],
        },
        Items: {
            getAsync: async id => Array.isArray(id)
                ? id.map(value => byID.get(value)).filter(Boolean)
                : byID.get(id) || null,
        },
        getMainWindow: () => ({
            ZoteroPane: {
                selectItem: async id => id,
            },
        }),
    };
}

test('discovers personal and group libraries while excluding feeds', async () => {
    const runtime = createRuntime([]);
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });
    assert.deepEqual(await library.listLibraries(), [
        {
            libraryID: 1,
            name: 'Personal',
            type: 'user',
            editable: true,
            filesEditable: true,
        },
        {
            libraryID: 2,
            name: 'Read-only Group',
            type: 'group',
            editable: false,
            filesEditable: false,
        },
    ]);
});

test('accepts a callable Zotero namespace from a wrapped bootstrap realm', async () => {
    const runtime = Object.assign(
        function zoteroNamespace() {},
        createRuntime([])
    );
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });

    assert.equal((await library.listLibraries())[0].libraryID, 1);
});

test('falls back to the personal library when library enumeration is unavailable', async () => {
    const runtime = createRuntime([]);
    runtime.Libraries.getAll = () => {
        throw new Error('library manager is not ready');
    };
    runtime.Libraries.get = () => null;
    const library = createZoteroReferenceLibrary(runtime);

    assert.deepEqual(await library.listLibraries(), [{
        libraryID: 1,
        name: 'My Library',
        type: 'user',
        editable: true,
        filesEditable: true,
    }]);
});

test('projects the source item library when the library cache is empty', async () => {
    const source = item({ id: 90, libraryID: 7, title: 'Source' });
    const runtime = createRuntime([source]);
    runtime.Libraries.getAll = () => [];
    runtime.Libraries.get = () => null;
    const library = createZoteroReferenceLibrary(runtime);

    assert.deepEqual(await library.listLibraries({ sourceItemID: 90 }), [
        {
            libraryID: 1,
            name: 'My Library',
            type: 'user',
            editable: true,
            filesEditable: true,
        },
        {
            libraryID: 7,
            name: 'Group 7',
            type: 'group',
            editable: false,
            filesEditable: false,
        },
    ]);
});

test('waits for Zotero initialization before enumerating libraries', async () => {
    const runtime = createRuntime([]);
    let resolveInitialization;
    let initialized = false;
    runtime.initializationPromise = new Promise(resolve => {
        resolveInitialization = resolve;
    });
    runtime.Libraries.getAll = () => {
        if (!initialized) throw new Error('library cache is not initialized');
        return [{
            libraryID: 1,
            name: 'Personal',
            libraryType: 'user',
            editable: true,
            filesEditable: true,
        }];
    };
    const library = createZoteroReferenceLibrary(runtime);
    const listing = library.listLibraries();

    await Promise.resolve();
    initialized = true;
    resolveInitialization();
    assert.deepEqual(await listing, [{
        libraryID: 1,
        name: 'Personal',
        type: 'user',
        editable: true,
        filesEditable: true,
    }]);
});

test('defaults a read-only source group to the personal library', async () => {
    const source = item({ id: 90, libraryID: 2, title: 'Source' });
    const runtime = createRuntime([source]);
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });

    assert.equal(await library.getDefaultLibraryID(90), 1);
});

test('indexes exact DOI matches and detects PDF attachments across libraries', async () => {
    const pdf = {
        id: 20,
        isPDFAttachment: () => true,
        getField: () => '',
    };
    const personal = item({
        id: 10,
        libraryID: 1,
        title: 'Paper',
        DOI: '10.1000/Example',
        attachments: [20],
    });
    const group = item({
        id: 11,
        libraryID: 2,
        title: 'Paper',
        DOI: '10.1000/Example',
    });
    const runtime = createRuntime([personal, group, pdf]);
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async id => id === 1 ? [personal] : [group],
    });
    const result = await library.find({
        text: 'Paper',
        identifiers: { doi: '10.1000/example' },
    }, { targetLibraryID: 1 });
    assert.equal(result.selectedMatches.length, 1);
    assert.equal(result.selectedMatches[0].hasPDF, true);
    assert.equal(result.otherMatches.length, 1);
    assert.equal(result.otherMatches[0].libraryID, 2);
    assert.equal(result.otherMatches[0].libraryName, 'Read-only Group');
});

test('indexes arXiv and explicit PMID fields while excluding deleted items', async () => {
    const arxiv = item({
        id: 12,
        libraryID: 1,
        title: 'arXiv paper',
        extra: 'arXiv:2401.00001v2',
    });
    const pmid = item({
        id: 13,
        libraryID: 1,
        title: 'PubMed paper',
        PMID: '123456',
    });
    const deleted = item({
        id: 14,
        libraryID: 1,
        title: 'Deleted paper',
        DOI: '10.1000/deleted',
        deleted: true,
    });
    const runtime = createRuntime([arxiv, pmid, deleted]);
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [arxiv, pmid, deleted],
    });

    const arxivResult = await library.find({
        identifiers: { arxivID: '2401.00001' },
    }, { targetLibraryID: 1 });
    const pmidResult = await library.find({
        identifiers: { pmid: '123456' },
    }, { targetLibraryID: 1 });
    const deletedResult = await library.find({
        identifiers: { doi: '10.1000/deleted' },
    }, { targetLibraryID: 1 });

    assert.equal(arxivResult.selectedMatches[0].itemID, 12);
    assert.equal(pmidResult.selectedMatches[0].itemID, 13);
    assert.equal(deletedResult.selectedMatches.length, 0);
});

test('indexes OpenAlex IDs stored in Zotero Extra', async () => {
    const book = item({
        id: 18,
        libraryID: 1,
        title: 'Compilers: Principles, Techniques, and Tools',
        extra: 'OpenAlex ID: W1721908487',
    });
    const library = createZoteroReferenceLibrary(createRuntime([book]), {
        loadItems: async () => [book],
    });
    const result = await library.find({
        identifiers: { openAlexID: 'https://openalex.org/W1721908487' },
    }, { targetLibraryID: 1 });
    assert.equal(result.selectedMatches[0].itemID, 18);
    assert.equal(result.selectedMatches[0].identifiers.openAlexID, 'W1721908487');
});

test('marks duplicate exact identifiers as ambiguous instead of choosing an item', async () => {
    const first = item({ id: 15, libraryID: 1, DOI: '10.1000/duplicate' });
    const second = item({ id: 16, libraryID: 1, DOI: '10.1000/duplicate' });
    const library = createZoteroReferenceLibrary(createRuntime([first, second]), {
        loadItems: async () => [first, second],
    });

    const result = await library.find({
        identifiers: { doi: '10.1000/duplicate' },
    }, { targetLibraryID: 1 });

    assert.equal(result.ambiguous, true);
    assert.deepEqual(result.selectedMatches.map(match => match.itemID), [15, 16]);
});

test('propagates an attachment lookup abort while building the index', async () => {
    const parent = item({
        id: 17,
        libraryID: 1,
        DOI: '10.1000/abort',
        attachments: [18],
    });
    const runtime = createRuntime([parent]);
    runtime.Items.getAsync = async id => {
        if (id === 18) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return id === 17 ? parent : null;
    };
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [parent],
    });
    await assert.rejects(
        library.find({ identifiers: { doi: '10.1000/abort' } }, {
            targetLibraryID: 1,
        }),
        error => error.name === 'AbortError'
    );
});

test('uses native Zotero search translator with selected library', async () => {
    const calls = [];
    const translated = item({ id: 30, libraryID: 1, title: 'Imported' });
    const runtime = createRuntime([]);
    const translator = {
        setIdentifier(value) { calls.push(['identifier', value]); },
        async getTranslators() { calls.push(['getTranslators']); return [{}]; },
        setTranslator() { calls.push(['setTranslator']); },
        async translate(options) {
            calls.push(['translate', options]);
            return [translated];
        },
    };
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
        translateFactory: () => translator,
    });
    const result = await library.translateIdentifier({
        reference: { identifiers: { doi: '10.1000/test' } },
        libraryID: 1,
    });
    assert.equal(result.items[0], translated);
    assert.deepEqual(calls[0], ['identifier', { DOI: '10.1000/test' }]);
    assert.deepEqual(calls.at(-1), [
        'translate',
        { libraryID: 1, saveAttachments: true },
    ]);
});

test('maps arXiv and PMID identifiers through the native translator contract', async () => {
    const calls = [];
    const translator = {
        setIdentifier(value) { calls.push(value); },
        async getTranslators() { return [{}]; },
        setTranslator() {},
        async translate() { return [{ id: 31 }]; },
    };
    const library = createZoteroReferenceLibrary(createRuntime([]), {
        loadItems: async () => [],
        translateFactory: () => translator,
    });

    await library.translateIdentifier({
        reference: { identifiers: { arxivID: '2401.00001' } },
        libraryID: 1,
    });
    await library.translateIdentifier({
        reference: { identifiers: { pmid: '123456' } },
        libraryID: 1,
    });

    assert.deepEqual(calls, [
        { arXiv: '2401.00001' },
        { PMID: '123456' },
    ]);
});

test('creates a bounded Zotero item from confirmed OpenAlex metadata', async () => {
    const saved = [];
    const runtime = createRuntime([]);
    runtime.Item = class {
        constructor(type) {
            this.itemType = type;
            this.fields = {};
            this.creators = [];
            this.id = null;
        }

        setField(field, value) {
            this.fields[field] = value;
        }

        setCreator(index, creator) {
            this.creators[index] = creator;
        }

        async saveTx(options) {
            saved.push(options);
            this.id = 77;
            return this.id;
        }
    };
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });
    const result = await library.importMetadata({
        reference: {
            identifiers: { openAlexID: 'https://openalex.org/W1721908487' },
        },
        metadata: {
            itemType: 'book',
            title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
            year: 2006,
            authors: ['Alfred V. Aho', 'Monica S. Lam'],
            publisher: 'Addison-Wesley',
            url: 'https://example.org/book',
        },
        libraryID: 1,
    });
    assert.equal(result.items[0].itemType, 'book');
    assert.equal(result.items[0].id, 77);
    assert.deepEqual(result.items[0].fields, {
        title: 'Compilers: Principles, Techniques, and Tools (2nd Edition)',
        date: '2006',
        publisher: 'Addison-Wesley',
        url: 'https://example.org/book',
        extra: 'OpenAlex ID: W1721908487',
    });
    assert.deepEqual(result.items[0].creators, [{
        firstName: 'Alfred V.',
        lastName: 'Aho',
        creatorType: 'author',
    }, {
        firstName: 'Monica S.',
        lastName: 'Lam',
        creatorType: 'author',
    }]);
    assert.deepEqual(saved, [{ skipSelect: true }]);
});

test('rejects PDF attachment import into a read-only library', async () => {
    const library = createZoteroReferenceLibrary(createRuntime([]), {
        loadItems: async () => [],
    });
    await assert.rejects(
        library.attachPDF({
            itemID: 1,
            libraryID: 2,
            url: 'https://example.org/paper.pdf',
        }),
        error => error.code === 'REFERENCE_FILES_READ_ONLY'
    );
});

test('uses the Zotero 7–9 options-object API and rejects private PDF hosts', async () => {
    const calls = [];
    const runtime = createRuntime([]);
    runtime.Attachments = {
        async importFromURL(options) {
            calls.push(options);
            return { id: 40, libraryID: 1 };
        },
    };
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });
    await library.attachPDF({
        itemID: 30,
        libraryID: 1,
        url: 'https://example.org/paper.pdf',
    });
    assert.deepEqual(calls, [{
        url: 'https://example.org/paper.pdf',
        parentItemID: 30,
        libraryID: 1,
        contentType: 'application/pdf',
        fileBaseName: 'reference.pdf',
    }]);
    await assert.rejects(
        library.attachPDF({
            itemID: 30,
            libraryID: 1,
            url: 'http://127.0.0.1/private.pdf',
        }),
        error => error.code === 'REFERENCE_PDF_URL_INVALID'
    );
});

test('returns bounded title, author, and year candidates as advisory matches', async () => {
    const candidate = item({
        id: 41,
        libraryID: 1,
        title: 'A Distinctive Research Title',
        creators: [{ lastName: 'Doe' }],
    });
    const library = createZoteroReferenceLibrary(createRuntime([candidate]), {
        loadItems: async libraryID => libraryID === 1 ? [candidate] : [],
    });
    const result = await library.find({
        text: 'Doe. A Distinctive Research Title. Journal. 2024.',
        year: '2024',
        authorSearchText: 'doe',
        identifiers: {},
    }, { targetLibraryID: 1 });
    assert.equal(result.selectedMatches.length, 0);
    assert.deepEqual(result.candidates.map(match => match.itemID), [41]);
    assert.deepEqual(result.candidates[0].identifiers, {
        doi: '',
        arxivID: '',
        pmid: '',
    });
});

test('copies metadata across libraries and preserves it when files are disabled', async () => {
    const source = item({ id: 42, libraryID: 1, title: 'Source' });
    source.clone = libraryID => ({
        id: 52,
        libraryID,
        async saveTx() { return this.id; },
    });
    const runtime = createRuntime([source]);
    runtime.Libraries.getAll = () => [{
        libraryID: 1,
        name: 'Personal',
        libraryType: 'user',
        editable: true,
        filesEditable: true,
    }, {
        libraryID: 4,
        name: 'Metadata-only Group',
        libraryType: 'group',
        editable: true,
        filesEditable: false,
    }];
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => [],
    });
    assert.deepEqual(await library.copyItem({
        itemID: 42,
        targetLibraryID: 4,
    }), { itemID: 52, hasPDF: false });
});

test('opens a regular Zotero item and invalidates a stale index', async () => {
    const opened = [];
    const itemValue = item({ id: 61, libraryID: 1, DOI: '10.1000/new' });
    let items = [];
    const runtime = createRuntime([itemValue]);
    runtime.getMainWindow = () => ({
        ZoteroPane: {
            async selectItem(id) { opened.push(id); },
        },
    });
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async () => items,
    });

    assert.equal((await library.find({ identifiers: { doi: '10.1000/new' } }, {
        targetLibraryID: 1,
    })).selectedMatches.length, 0);
    items = [itemValue];
    assert.equal((await library.find({ identifiers: { doi: '10.1000/new' } }, {
        targetLibraryID: 1,
    })).selectedMatches.length, 0);
    library.invalidate();
    assert.equal((await library.find({ identifiers: { doi: '10.1000/new' } }, {
        targetLibraryID: 1,
    })).selectedMatches[0].itemID, 61);
    await library.openItem(61);
    assert.deepEqual(opened, [61]);
});

test('cancels an in-progress index before loading the next library', async () => {
    const controller = new AbortController();
    let started = false;
    const library = createZoteroReferenceLibrary(createRuntime([]), {
        loadItems: async (_libraryID, { signal }) => {
            started = true;
            await new Promise(resolve => {
                signal.addEventListener('abort', resolve, { once: true });
            });
            signal.throwIfAborted?.();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
    });
    const pending = library.refreshIndex({ signal: controller.signal });
    while (!started) await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('keeps a shared index alive for another caller when one signal aborts', async () => {
    let started = false;
    let release;
    let waits = 0;
    const runtime = createRuntime([]);
    const library = createZoteroReferenceLibrary(runtime, {
        loadItems: async (_libraryID, { signal }) => {
            if (waits++ === 0) {
                started = true;
                await new Promise(resolve => {
                    release = resolve;
                    signal.addEventListener('abort', resolve, { once: true });
                });
            }
            signal.throwIfAborted?.();
            return [];
        },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = library.refreshIndex({ signal: firstController.signal });
    while (!started) await Promise.resolve();
    const second = library.refreshIndex({ signal: secondController.signal });
    firstController.abort();
    await assert.rejects(first, error => error.name === 'AbortError');
    release();
    await second;
    assert.equal(secondController.signal.aborted, false);
});

test('disposes and aborts a shared index build', async () => {
    let started = false;
    const library = createZoteroReferenceLibrary(createRuntime([]), {
        loadItems: async (_libraryID, { signal }) => {
            started = true;
            await new Promise(resolve => {
                signal.addEventListener('abort', resolve, { once: true });
            });
            signal.throwIfAborted?.();
            return [];
        },
    });
    const pending = library.refreshIndex();
    while (!started) await Promise.resolve();
    library.dispose();
    await assert.rejects(pending, error => error.name === 'AbortError');
    await assert.rejects(
        library.refreshIndex(),
        error => error.code === 'REFERENCE_LIBRARY_DISPOSED'
    );
});
