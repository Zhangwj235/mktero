import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCitationPopup } from '../src/editor/citation-popup.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function createHarness() {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">cite</button></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    anchor.getBoundingClientRect = () => ({
        left: 20,
        right: 60,
        top: 20,
        bottom: 40,
        width: 40,
        height: 20,
    });
    return { dom, document, parent, anchor };
}

function reference() {
    return {
        id: 'number:1',
        number: 1,
        text: 'Doe. Paper. doi:10.1000/test. 2024.',
        identifiers: { doi: '10.1000/test' },
    };
}

function nextTask() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

test('renders XHTML controls and closes after opening a Zotero match', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const opened = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'present',
            match: { itemID: 7, libraryID: 1, hasPDF: true },
        }),
        onOpenReferenceMatch: async match => opened.push(match.itemID),
    });
    await nextTask();

    const row = document.querySelector('.mktero-citation-popup-item');
    const select = document.querySelector('.mktero-citation-popup-library-select');
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(row.namespaceURI, XHTML_NAMESPACE);
    assert.equal(row.matches('button'), false);
    assert.equal(row.hasAttribute('tabindex'), false);
    assert.equal(select.namespaceURI, XHTML_NAMESPACE);
    assert.equal(action.textContent, 'Open in Zotero');

    action.click();
    await nextTask();
    assert.deepEqual(opened, [7]);
    assert.equal(document.querySelector('.mktero-citation-popup'), null);

    popup.destroy();
    dom.window.close();
});

test('keeps row navigation separate from the import action', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let activated = 0;
    let imported = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onActivate: () => { activated++; },
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: true,
        }),
        onImportReference: async () => {
            imported++;
            return { state: 'imported' };
        },
    });
    await nextTask();

    const row = document.querySelector('.mktero-citation-popup-item');
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(row.querySelectorAll('button').length, 2);
    assert.equal(row.querySelector('button')?.parentElement, row);
    action.click();
    await nextTask();
    assert.equal(imported, 1);
    assert.equal(activated, 0);

    popup.destroy();
    dom.window.close();
});

test('reports the matching group-library name and offers explicit copy', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let copied = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'present-other-library',
            canImport: true,
            otherMatches: [{ libraryID: 8, libraryName: 'Research Group' }],
        }),
        onImportReference: async () => {
            copied++;
            return { state: 'present-no-pdf' };
        },
    });
    await nextTask();

    assert.match(
        document.querySelector('.mktero-citation-popup-status').textContent,
        /Research Group/
    );
    assert.equal(document.querySelector('.mktero-citation-popup-action').textContent,
        'Copy to selected library');
    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();
    assert.equal(copied, 1);

    popup.destroy();
    dom.window.close();
});

test('keeps read-only libraries visible and disables their import action', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        targetLibraryID: 2,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 2,
                name: 'Shared',
                type: 'group',
                editable: false,
                filesEditable: false,
            }],
            defaultLibraryID: 2,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: false,
            targetLibraryEditable: false,
            targetLibraryFilesEditable: false,
        }),
        onImportReference: async () => ({ state: 'imported' }),
    });
    await nextTask();

    const option = document.querySelector('option');
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.match(option.textContent, /Shared.*Read-only/);
    assert.equal(option.disabled, false);
    assert.match(
        document.querySelector('.mktero-citation-popup-status').textContent,
        /Read-only/
    );
    assert.equal(action.hidden, true);

    popup.destroy();
    dom.window.close();
});

test('populates the library selector and refreshes status after switching libraries', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const statusLibraryIDs = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [
                {
                    libraryID: 1,
                    name: 'Personal',
                    type: 'user',
                    editable: true,
                    filesEditable: true,
                },
                {
                    libraryID: 8,
                    name: 'Research Group',
                    type: 'group',
                    editable: true,
                    filesEditable: true,
                },
            ],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async (_target, { targetLibraryID }) => {
            statusLibraryIDs.push(String(targetLibraryID));
            return { state: 'absent', canImport: true };
        },
    });
    await nextTask();
    await nextTask();

    const select = document.querySelector('.mktero-citation-popup-library-select');
    assert.equal(select.disabled, false);
    assert.deepEqual(
        [...select.options].map(option => option.textContent),
        ['Personal', 'Research Group']
    );
    assert.equal(select.value, '1');

    select.value = '8';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await nextTask();
    assert.ok(statusLibraryIDs.includes('8'));

    popup.destroy();
    dom.window.close();
});

test('shows a visible placeholder when library loading fails', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => {
            throw new Error('library service unavailable');
        },
    });
    await nextTask();
    await nextTask();

    const select = document.querySelector('.mktero-citation-popup-library-select');
    assert.equal(select.disabled, true);
    assert.equal(select.options.length, 1);
    assert.equal(select.options[0].textContent, 'Zotero libraries could not be loaded');
    assert.equal(select.options[0].disabled, true);

    popup.destroy();
    dom.window.close();
});

test('aborts status work on close and ignores an old-library import result', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let importResolve;
    let secondStatusResolve;
    let observedSignal;
    let unsubscribed = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async ({ signal }) => {
            observedSignal = signal;
            return {
                libraries: [1, 2].map(libraryID => ({
                    libraryID,
                    name: `Library ${libraryID}`,
                    type: libraryID === 1 ? 'user' : 'group',
                    editable: true,
                    filesEditable: true,
                })),
                defaultLibraryID: 1,
            };
        },
        onGetReferenceStatus: async (_target, { targetLibraryID }) => {
            if (String(targetLibraryID) === '2') {
                return new Promise(resolve => { secondStatusResolve = resolve; });
            }
            return { state: 'absent', canImport: true };
        },
        onImportReference: async () => new Promise(resolve => {
            importResolve = resolve;
        }),
        onSubscribeReferenceUpdates: () => () => { unsubscribed++; },
    });
    await nextTask();

    document.querySelector('.mktero-citation-popup-action').click();
    const select = document.querySelector('.mktero-citation-popup-library-select');
    select.value = '2';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await nextTask();
    importResolve({ state: 'imported', match: { itemID: 9 } });
    await nextTask();
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'checking'
    );

    popup.close();
    assert.equal(observedSignal.aborted, true);
    assert.equal(unsubscribed, 1);
    secondStatusResolve({ state: 'absent', canImport: true });
    popup.destroy();
    dom.window.close();
});
