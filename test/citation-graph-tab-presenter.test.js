import test from 'node:test';
import assert from 'node:assert/strict';
import { CitationGraphTabPresenter } from '../src/ui/citation-graph-tab-presenter.js';

function createSnapshot(selectedItemID, changes = {}) {
    return {
        libraryID: 1,
        libraryName: 'My Library',
        nodes: [{
            id: '1:A',
            itemID: 7,
            title: 'Paper',
            degree: 0,
            inDegree: 0,
            outDegree: 0,
        }],
        edges: [],
        selectedItemID,
        status: 'complete',
        progress: { completed: 0, total: 0, failed: 0 },
        warnings: [],
        ...changes,
    };
}

function createMainWindow() {
    const added = [];
    const selected = [];
    const closed = [];
    const renamed = [];
    let nextID = 1;
    const tabs = {
        add(options) {
            const children = [];
            const tab = {
                id: `tab-${nextID++}`,
                options,
                children,
                container: {
                    appendChild(child) {
                        children.push(child);
                    },
                },
            };
            added.push(tab);
            return { id: tab.id, container: tab.container };
        },
        select(tabID) {
            selected.push(tabID);
        },
        close(tabIDs) {
            for (const tabID of Array.isArray(tabIDs) ? tabIDs : [tabIDs]) {
                closed.push(tabID);
                added.find(tab => tab.id === tabID)?.options.onClose?.();
            }
        },
        rename(tabID, title) {
            renamed.push({ tabID, title });
        },
        getState() {
            return [
                { type: 'library', data: {} },
                { type: 'mktero', data: { mkteroItemID: 42 } },
                { type: 'mktero', data: { mkteroCitationLibraryID: 1 } },
            ];
        },
    };
    return {
        document: {},
        Zotero_Tabs: tabs,
        added,
        selected,
        closed,
        renamed,
    };
}

function createViewHarness() {
    const views = [];
    const calls = [];
    return {
        views,
        calls,
        createView(options) {
            calls.push(options);
            const view = {
                root: { kind: 'citation-graph-view' },
                renderCalls: [],
                focusCalls: [],
                destroyCalls: 0,
                render(snapshot) {
                    this.renderCalls.push(snapshot);
                },
                focus(itemID) {
                    this.focusCalls.push(itemID);
                    return true;
                },
                destroy() {
                    this.destroyCalls++;
                },
            };
            views.push(view);
            return view;
        },
    };
}

function createControllerHarness() {
    const controllers = [];
    return {
        controllers,
        createAbortController() {
            const signal = { aborted: false };
            const controller = {
                signal,
                abort() {
                    signal.aborted = true;
                },
            };
            controllers.push(controller);
            return controller;
        },
    };
}

function createPresenter({ graph = null } = {}) {
    const mainWindow = createMainWindow();
    const viewHarness = createViewHarness();
    const controllerHarness = createControllerHarness();
    const opened = [];
    const graphCalls = [];
    const citationGraph = graph || {
        async getLibraryGraph(options) {
            graphCalls.push(options);
            const snapshot = createSnapshot(options.focusItemID, {
                status: 'refreshing',
                progress: { completed: 0, total: 1, failed: 0 },
            });
            const finalSnapshot = createSnapshot(options.focusItemID);
            return {
                snapshot,
                completion: Promise.resolve().then(() => {
                    options.onProgress(finalSnapshot);
                    return finalSnapshot;
                }),
            };
        },
    };
    const zotero = {
        getMainWindow: () => mainWindow,
        Session: {
            state: {
                windows: [{
                    tabs: [
                        { type: 'library', data: {} },
                        { type: 'mktero', data: { mkteroCitationLibraryID: 9 } },
                    ],
                }],
            },
        },
    };
    const presenter = new CitationGraphTabPresenter({
        zotero,
        rootURI: 'resource://mktero/',
        graph: citationGraph,
        library: { openPaper: node => opened.push(node.itemID) },
        getLibraryName: () => 'My Library',
        createView: viewHarness.createView.bind(viewHarness),
        createAbortController: controllerHarness.createAbortController,
    });
    return {
        presenter,
        mainWindow,
        viewHarness,
        controllerHarness,
        graphCalls,
        opened,
        zotero,
    };
}

test('opens one session-only graph tab per library and reuses it with new focus', async () => {
    const harness = createPresenter();

    const first = harness.presenter.open(1, { focusItemID: 7 });
    await first.refreshPromise;
    const second = harness.presenter.open(1, { focusItemID: 8 });

    assert.equal(first, second);
    assert.equal(harness.mainWindow.added.length, 1);
    assert.equal(harness.mainWindow.added[0].options.type, 'mktero');
    assert.equal(
        harness.mainWindow.added[0].options.data.mkteroCitationLibraryID,
        1
    );
    assert.deepEqual(first.view.focusCalls, [7, 8]);
    assert.deepEqual(harness.mainWindow.selected, [first.tabID, first.tabID]);
    assert.deepEqual(
        harness.mainWindow.Zotero_Tabs.getState().map(tab => tab.type),
        ['library']
    );
    assert.deepEqual(
        harness.zotero.Session.state.windows[0].tabs.map(tab => tab.type),
        ['library']
    );
});

test('renders the cache snapshot and incremental completion through the live view', async () => {
    const harness = createPresenter();
    const presentation = harness.presenter.open(1, { focusItemID: 7 });

    await presentation.refreshPromise;

    assert.deepEqual(
        presentation.view.renderCalls.map(snapshot => snapshot.status),
        ['loading', 'refreshing', 'complete', 'complete']
    );
    assert.equal(harness.graphCalls[0].libraryID, 1);
    assert.equal(harness.graphCalls[0].focusItemID, 7);
    assert.equal(harness.graphCalls[0].forceRefresh, false);
});

test('force refresh aborts an in-flight library request', async () => {
    const pending = [];
    const graph = {
        async getLibraryGraph(options) {
            return new Promise(resolve => pending.push({ options, resolve }));
        },
    };
    const harness = createPresenter({ graph });
    const presentation = harness.presenter.open(1, { focusItemID: 7 });
    const firstController = harness.controllerHarness.controllers[0];

    harness.presenter.open(1, { focusItemID: 8, forceRefresh: true });

    assert.equal(firstController.signal.aborted, true);
    assert.equal(harness.controllerHarness.controllers.length, 2);
    assert.equal(pending[1].options.forceRefresh, true);
    pending[1].resolve({
        snapshot: createSnapshot(8),
        completion: Promise.resolve(createSnapshot(8)),
    });
    await presentation.refreshPromise;
});

test('closing and disposing abort refresh work and destroy graph views', () => {
    const harness = createPresenter({
        graph: {
            async getLibraryGraph() {
                return new Promise(() => {});
            },
        },
    });
    const first = harness.presenter.open(1, { focusItemID: 7 });
    const second = harness.presenter.open(2, { focusItemID: 9 });

    harness.mainWindow.Zotero_Tabs.close(first.tabID);
    assert.equal(harness.controllerHarness.controllers[0].signal.aborted, true);
    assert.equal(first.view.destroyCalls, 1);
    assert.equal(harness.presenter.get(1), null);

    harness.presenter.dispose();
    assert.equal(harness.controllerHarness.controllers[1].signal.aborted, true);
    assert.equal(second.view.destroyCalls, 1);
    assert.ok(harness.mainWindow.closed.includes(second.tabID));
});

test('window unload closes and aborts graph tabs owned by that window', () => {
    const harness = createPresenter({
        graph: {
            async getLibraryGraph() {
                return new Promise(() => {});
            },
        },
    });
    const presentation = harness.presenter.open(1, { focusItemID: 7 });

    harness.presenter.closeForWindow(harness.mainWindow);

    assert.equal(harness.controllerHarness.controllers[0].signal.aborted, true);
    assert.equal(presentation.view.destroyCalls, 1);
    assert.equal(harness.presenter.get(1), null);
});
