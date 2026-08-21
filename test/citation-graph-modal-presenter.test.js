import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
    CitationGraphModalPresenter,
} from '../src/ui/citation-graph-modal-presenter.js';

function createSnapshot() {
    return {
        libraryID: 1,
        libraryName: 'My Library',
        nodes: [
            { id: '1:A', itemID: 7, title: 'Current', doi: '10.1000/a' },
            { id: '1:B', itemID: 8, title: 'Reference', doi: '10.1000/b' },
            { id: '1:C', itemID: 9, title: 'Other', doi: '10.1000/c' },
        ],
        edges: [
            { source: '1:A', target: '1:B' },
            { source: '1:C', target: '1:A' },
        ],
        selectedItemID: 7,
        status: 'complete',
        progress: { completed: 1, total: 1, failed: 0 },
        warnings: [],
    };
}

function createHarness({ onOpenPaper = null } = {}) {
    const { document, window } = parseHTML('<html><body></body></html>');
    const renders = [];
    const views = [];
    let openPaperHandler = null;
    const graphSnapshot = createSnapshot();
    const graph = {
        async getLibraryGraph() {
            return {
                snapshot: graphSnapshot,
                completion: Promise.resolve(graphSnapshot),
            };
        },
    };
    const presenter = new CitationGraphModalPresenter({
        zotero: {
            getMainWindow: () => window,
            logError() {},
        },
        graph,
        library: { openPaper: async () => {} },
        onOpenPaper,
        getLibraryName: () => 'My Library',
        createView(options) {
            openPaperHandler = options.onOpenPaper;
            const root = document.createElement('div');
            const view = {
                root,
                render(snapshot) { renders.push(snapshot); },
                destroy() { views.push('destroyed'); root.remove(); },
            };
            return view;
        },
    });
    return {
        document,
        window,
        presenter,
        renders,
        views,
        get openPaperHandler() {
            return openPaperHandler;
        },
    };
}

test('opens a modal with only the focused paper citation graph', async () => {
    const harness = createHarness();
    const presentation = harness.presenter.open({
        libraryID: 1,
        focusItemID: 7,
    });

    await presentation.refreshPromise;

    assert.ok(harness.document.querySelector('.mktero-citation-graph-modal-host'));
    const rendered = harness.renders.at(-1);
    assert.deepEqual(rendered.nodes.map(node => node.itemID), [7, 8]);
    assert.deepEqual(rendered.edges, [{ source: '1:A', target: '1:B' }]);
    assert.equal(rendered.selectedItemID, 7);
});

test('closes the modal and aborts its active refresh', () => {
    const harness = createHarness();
    let controller;
    const presentation = harness.presenter.open({
        libraryID: 1,
        focusItemID: 7,
    });
    controller = presentation.controller;

    harness.presenter.close();

    assert.equal(controller.signal.aborted, true);
    assert.equal(harness.document.querySelector('.mktero-citation-graph-modal-host'), null);
    assert.deepEqual(harness.views, ['destroyed']);
});

test('uses the injected paper opener for graph navigation', async () => {
    const opened = [];
    const harness = createHarness({
        onOpenPaper: node => opened.push(node.itemID),
    });
    const presentation = harness.presenter.open({
        libraryID: 1,
        focusItemID: 7,
    });

    await presentation.refreshPromise;
    await harness.openPaperHandler({ itemID: 8 });

    assert.deepEqual(opened, [8]);
});

test('closes a modal when either the source attachment or focused item closes', () => {
    const harness = createHarness();
    harness.presenter.open({
        libraryID: 1,
        focusItemID: 7,
        sourceItemID: 42,
    });

    harness.presenter.closeForItem(42);
    assert.equal(harness.document.querySelector('.mktero-citation-graph-modal-host'), null);

    harness.presenter.open({
        libraryID: 1,
        focusItemID: 7,
        sourceItemID: 42,
    });
    harness.presenter.closeForItem(7);
    assert.equal(harness.document.querySelector('.mktero-citation-graph-modal-host'), null);
});
