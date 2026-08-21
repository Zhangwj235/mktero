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
