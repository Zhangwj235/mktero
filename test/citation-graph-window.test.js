import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createCitationGraphView } from '../src/ui/citation-graph-window.js';

const GRAPH_STYLES = readFileSync(
    new URL('../ui/citation-graph.css', import.meta.url),
    'utf8'
);

function createSnapshot(changes = {}) {
    return {
        libraryID: 1,
        libraryName: 'My Library',
        nodes: [
            {
                id: '1:A',
                itemID: 7,
                title: 'Focused paper',
                year: 2026,
                doi: '10.1000/focused',
                arxivID: '',
                inDegree: 0,
                outDegree: 1,
                degree: 1,
            },
            {
                id: '1:B',
                itemID: 8,
                title: 'Referenced paper',
                year: 2025,
                doi: '',
                arxivID: '2501.00001',
                inDegree: 1,
                outDegree: 0,
                degree: 1,
            },
            {
                id: '1:C',
                itemID: 9,
                title: 'Isolated paper',
                year: null,
                doi: '',
                arxivID: '',
                inDegree: 0,
                outDegree: 0,
                degree: 0,
            },
        ],
        edges: [{ source: '1:A', target: '1:B' }],
        selectedItemID: 7,
        status: 'complete',
        progress: { completed: 0, total: 0, failed: 0 },
        warnings: [],
        fetchedAt: null,
        ...changes,
    };
}

function createHarness() {
    const { document, window } = parseHTML('<html><body></body></html>');
    const context = createCanvasContext();
    window.devicePixelRatio = 2;
    window.HTMLCanvasElement.prototype.getContext = () => context;
    let scheduledFrame = 0;
    const cancelledFrames = [];
    const frameCallbacks = new Map();
    const observer = {
        observed: [],
        disconnected: false,
        observe(element) {
            this.observed.push(element);
        },
        disconnect() {
            this.disconnected = true;
        },
    };
    const simulation = {
        stopped: false,
        tickCalls: [],
        tickListener: null,
        endListener: null,
        on(name, listener) {
            if (name === 'tick') this.tickListener = listener;
            if (name === 'end') this.endListener = listener;
            return this;
        },
        stop() {
            this.stopped = true;
            return this;
        },
        tick(iterations) {
            this.tickCalls.push(iterations);
            return this;
        },
        restart() {
            return this;
        },
        alpha() {
            return this;
        },
        alphaTarget() {
            return this;
        },
    };
    return {
        document,
        window,
        context,
        observer,
        simulation,
        cancelledFrames,
        createView(options = {}) {
            return createCitationGraphView({
                document,
                stylesheetText: GRAPH_STYLES,
                createSimulation(nodes) {
                    nodes.forEach((node, index) => {
                        node.x = 120 + index * 120;
                        node.y = 160 + index * 60;
                    });
                    return simulation;
                },
                createResizeObserver(callback) {
                    observer.callback = callback;
                    return observer;
                },
                requestAnimationFrame(callback) {
                    const id = ++scheduledFrame;
                    frameCallbacks.set(id, callback);
                    return id;
                },
                cancelAnimationFrame(id) {
                    cancelledFrames.push(id);
                    frameCallbacks.delete(id);
                },
                measure() {
                    return { width: 800, height: 600 };
                },
                ...options,
            });
        },
        flushFrame() {
            const entry = [...frameCallbacks.entries()][0];
            if (!entry) return;
            frameCallbacks.delete(entry[0]);
            entry[1]();
        },
    };
}

test('renders a stable canvas and focuses the requested paper', () => {
    const harness = createHarness();
    const view = harness.createView();

    view.render(createSnapshot());
    harness.flushFrame();

    const canvas = view.root.shadowRoot.querySelector('canvas');
    assert.equal(view.selectedItemID, 7);
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 1200);
    assert.equal(
        view.root.shadowRoot.querySelector('.citation-graph-counts').textContent,
        '3 papers · 1 citation'
    );
    assert.match(
        view.root.shadowRoot.querySelector('.citation-graph-details').textContent,
        /Focused paper/
    );
    assert.equal(
        view.root.shadowRoot.querySelectorAll('[data-relation="references"] button')
            .length,
        1
    );
});

test('recalculates the mounted canvas size and recenters the selected paper', () => {
    const harness = createHarness();
    let dimensions = { width: 800, height: 600 };
    const view = harness.createView({
        measure: () => dimensions,
    });
    view.render(createSnapshot());
    const selected = view.selectedNode();
    selected.x = 120;
    selected.y = 100;

    dimensions = { width: 1_000, height: 700 };
    view.resize();

    assert.equal(view.cssWidth, 1_000);
    assert.equal(view.cssHeight, 700);
    assert.equal(view.transform.x, 500 - selected.x);
    assert.equal(view.transform.y, 350 - selected.y);
});

test('recenters the selected paper after force layout settles', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot());
    const selected = view.selectedNode();
    selected.x = 640;
    selected.y = 480;
    view.transform = { x: 0, y: 0, scale: 1 };

    harness.simulation.endListener();

    assert.equal(view.transform.x, 400 - selected.x);
    assert.equal(view.transform.y, 300 - selected.y);
});

test('keeps the focused paper centered while layout is still moving', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot({ status: 'refreshing' }));
    const selected = view.selectedNode();
    selected.x = 640;
    selected.y = 480;

    harness.simulation.tickListener();

    assert.equal(view.transform.x, 400 - selected.x);
    assert.equal(view.transform.y, 300 - selected.y);
});

test('does not override manual zoom while force layout is moving', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot({ status: 'refreshing' }));
    view.zoomBy(1.25, { x: 300, y: 200 });
    const transform = { ...view.transform };
    const selected = view.selectedNode();
    selected.x = 640;
    selected.y = 480;

    harness.simulation.tickListener();

    assert.deepEqual(view.transform, transform);
});

test('search and connected filtering provide keyboard-accessible node controls', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot());
    const root = view.root.shadowRoot;
    const search = root.querySelector('.citation-graph-search');

    search.value = 'referenced';
    search.dispatchEvent(new harness.window.Event('input'));
    const result = root.querySelector('.citation-graph-search-results button');
    assert.equal(result.textContent, 'Referenced paper');
    result.dispatchEvent(new harness.window.Event('click', { bubbles: true }));
    assert.equal(view.selectedItemID, 8);

    root.querySelector('[data-filter="connected"]').dispatchEvent(
        new harness.window.Event('click')
    );
    assert.equal(
        root.querySelector('[data-filter="connected"]').getAttribute('aria-pressed'),
        'true'
    );
    assert.equal(root.querySelector('.citation-graph-visible-count').textContent, '2');
});

test('renders untrusted paper titles as inert text across graph controls', () => {
    const harness = createHarness();
    const title = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const view = harness.createView();
    view.render(createSnapshot({
        nodes: [{
            ...createSnapshot().nodes[0],
            title,
        }],
        edges: [],
    }));
    const root = view.root.shadowRoot;
    const search = root.querySelector('.citation-graph-search');

    search.value = 'script';
    search.dispatchEvent(new harness.window.Event('input'));

    assert.equal(root.querySelector('.citation-graph-paper-title').textContent, title);
    assert.equal(
        root.querySelector('.citation-graph-search-results button').textContent,
        title
    );
    assert.equal(root.querySelectorAll('img, script').length, 0);
});

test('incremental snapshots preserve a user selection and view transform', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot());
    view.focus(8);
    view.zoomBy(1.25, { x: 300, y: 200 });
    const transform = { ...view.transform };

    view.render(createSnapshot({ status: 'refreshing' }));

    assert.equal(view.selectedItemID, 8);
    assert.deepEqual(view.transform, transform);
});

test('reuses delegated listeners across search and detail rerenders', () => {
    const harness = createHarness();
    const view = harness.createView();
    const listenerCount = view.listeners.length;
    view.render(createSnapshot());
    const search = view.root.shadowRoot.querySelector('.citation-graph-search');

    for (let index = 0; index < 10; index++) {
        search.value = index % 2 ? 'focused' : 'referenced';
        search.dispatchEvent(new harness.window.Event('input'));
        view.focus(index % 2 ? 7 : 8, { center: false });
    }

    assert.equal(view.listeners.length, listenerCount);
});

test('shows hover details and uses distinct connected and isolated colors', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot());
    harness.flushFrame();
    const canvas = view.root.shadowRoot.querySelector('canvas');
    const move = new harness.window.Event('pointermove');
    Object.defineProperties(move, {
        clientX: { value: 400 },
        clientY: { value: 300 },
    });

    canvas.dispatchEvent(move);

    const hover = view.root.shadowRoot.querySelector('.citation-graph-hover');
    assert.equal(hover.hidden, false);
    assert.match(hover.textContent, /Focused paper/);
    assert.ok(harness.context.fillStyles.includes('#b45309'));
    assert.ok(harness.context.fillStyles.includes('#2f6f9f'));
    assert.ok(harness.context.fillStyles.includes('#6b7280'));
});

test('settles the force layout without animation when reduced motion is enabled', () => {
    const harness = createHarness();
    harness.window.matchMedia = query => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        addEventListener() {},
        removeEventListener() {},
    });
    const view = harness.createView();

    view.render(createSnapshot());

    assert.deepEqual(harness.simulation.tickCalls, [240]);
    assert.equal(harness.simulation.stopped, true);
});

test('renders graph warnings and navigation failures as localized status', async () => {
    const harness = createHarness();
    const errors = [];
    const view = harness.createView({
        onOpenPaper: async () => { throw new Error('missing'); },
        onError: error => errors.push(error.message),
    });
    view.render(createSnapshot({
        status: 'complete',
        warnings: [{ code: 'references-truncated', itemID: 7 }],
    }));
    const root = view.root.shadowRoot;

    assert.match(root.querySelector('.citation-graph-status').textContent, /1000/);
    root.querySelector('[data-action="open-paper"]').dispatchEvent(
        new harness.window.Event('click', { bubbles: true })
    );
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(errors, ['missing']);
    assert.match(
        root.querySelector('.citation-graph-status').textContent,
        /could not be opened/
    );
    assert.equal(
        root.querySelector('[data-action="reset"] [data-lucide]').dataset.lucide,
        'rotate-ccw'
    );
});

test('exposes refresh and Zotero navigation commands', () => {
    const harness = createHarness();
    const refreshed = [];
    const opened = [];
    const view = harness.createView({
        onRefresh: () => refreshed.push(true),
        onOpenPaper: node => opened.push(node.itemID),
    });
    view.render(createSnapshot());
    const root = view.root.shadowRoot;

    root.querySelector('[data-action="refresh"]').dispatchEvent(
        new harness.window.Event('click')
    );
    root.querySelector('[data-action="open-paper"]').dispatchEvent(
        new harness.window.Event('click', { bubbles: true })
    );

    assert.deepEqual(refreshed, [true]);
    assert.deepEqual(opened, [7]);
});

test('destroy stops simulation and releases frames, observers, and controls', () => {
    const harness = createHarness();
    const view = harness.createView();
    view.render(createSnapshot());

    view.destroy();

    assert.equal(harness.simulation.stopped, true);
    assert.deepEqual(harness.cancelledFrames, [1]);
    assert.equal(harness.observer.disconnected, true);
    assert.equal(view.root.shadowRoot.querySelector('canvas'), null);
});

function createCanvasContext() {
    const context = { fillStyles: [] };
    for (const method of [
        'arc',
        'beginPath',
        'clearRect',
        'closePath',
        'fillText',
        'lineTo',
        'moveTo',
        'restore',
        'save',
        'scale',
        'setTransform',
        'stroke',
        'translate',
    ]) {
        context[method] = () => {};
    }
    context.fill = () => context.fillStyles.push(context.fillStyle);
    context.measureText = text => ({ width: String(text).length * 7 });
    return context;
}
