import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';

function createModel(changes = {}) {
    return {
        itemID: 42,
        title: 'Converting PDF…',
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        sourceKind: null,
        cacheHit: false,
        preserveContent: false,
        warnings: [],
        error: '',
        onReparse: null,
        ...changes,
    };
}

function createView(model = createModel(), zotero = {}, options = {}) {
    const { document } = parseHTML('<html><body></body></html>');
    if (options.xul) {
        document.createXULElement = tagName => {
            options.xulCalls?.push(tagName);
            const element = document.createElement(tagName);
            element.setAttribute('data-test-xul-element', 'true');
            return element;
        };
    }
    options.configureWindow?.(document.defaultView);
    const view = createMarkdownTabView({
        document,
        rootURI: 'jar:file:///profile/extensions/mktero.xpi!/',
        model,
        zotero,
    });
    view.render(model);
    return { document, view, shadow: view.host.shadowRoot };
}

test('mounts the Markdown UI in an isolated inline shadow root', () => {
    const { view, shadow } = createView();

    assert.equal(view.root.localName, 'div');
    assert.equal(view.root.getAttribute('role'), 'region');
    assert.equal(
        shadow.querySelector('link[rel="stylesheet"]').getAttribute('href'),
        'jar:file:///profile/extensions/mktero.xpi!/ui/markdown.css'
    );
    assert.equal(shadow.querySelector('#mktero-loading').getAttribute('role'), 'status');
    assert.equal(
        shadow.querySelector('#mktero-status').textContent,
        'Converting PDF… 0%'
    );
});

test('uses a flexing XUL layout root in the Zotero main document', () => {
    const xulCalls = [];
    const { view } = createView(createModel(), {}, { xul: true, xulCalls });

    assert.equal(view.root.localName, 'vbox');
    assert.deepEqual(xulCalls, ['vbox']);
    assert.equal(view.root.getAttribute('data-test-xul-element'), 'true');
    assert.equal(view.root.getAttribute('flex'), '1');
    assert.equal(view.root.firstElementChild, view.host);
    assert.ok(view.host.shadowRoot.querySelector('#mktero-loading'));
    view.destroy();
});

test('replaces loading state with cached Markdown as soon as the model is ready', () => {
    const { view, shadow } = createView();

    view.render(createModel({
        title: 'Example Paper',
        status: 'ready',
        progress: 100,
        markdown: '# Example Paper\n\nConverted.',
        sourceKind: 'markdown',
        cacheHit: true,
    }));

    assert.equal(shadow.querySelector('#mktero-loading').hidden, true);
    assert.equal(shadow.querySelector('#mktero-preview').hidden, false);
    assert.equal(shadow.querySelector('#mktero-status').textContent, 'Cached MinerU Markdown');
    assert.match(
        shadow.querySelector('#mktero-preview').innerHTML,
        /<h1>Example Paper<\/h1>[\s\S]*<p>Converted\.<\/p>/
    );
    assert.equal(
        shadow.querySelector('#mktero-source').textContent,
        '# Example Paper\n\nConverted.'
    );
});

test('updates conversion progress directly in the inline view', () => {
    const { view, shadow } = createView();

    view.render(createModel({ progress: 10 }));

    assert.equal(
        shadow.querySelector('#mktero-loading-detail').textContent,
        'PDF uploaded. MinerU is parsing the document.'
    );
    assert.equal(shadow.querySelector('#mktero-loading-progress').value, 10);
    assert.equal(shadow.querySelector('#mktero-loading-progress-label').textContent, '10%');
});

test('routes rendered Markdown links through Zotero instead of navigating the main window', () => {
    const launched = [];
    const { document, view, shadow } = createView(
        createModel({
            status: 'ready',
            markdown: '[MinerU](https://mineru.net)',
            sourceKind: 'markdown',
        }),
        { launchURL: url => launched.push(url) }
    );
    const link = shadow.querySelector('#mktero-preview a');

    link.dispatchEvent(new document.defaultView.Event('click', {
        bubbles: true,
        cancelable: true,
    }));

    assert.deepEqual(launched, ['https://mineru.net']);
    view.destroy();
});

test('ignores an empty Markdown fragment without treating it as a CSS selector', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        markdown: '[Top](#)',
        sourceKind: 'markdown',
    }));
    const link = shadow.querySelector('#mktero-preview a');

    assert.doesNotThrow(() => link.dispatchEvent(new document.defaultView.Event('click', {
        bubbles: true,
        cancelable: true,
    })));
    view.destroy();
});

test('copies through Zotero when the main-window Clipboard API is unavailable', async () => {
    const copied = [];
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        markdown: '# Copy me',
        sourceKind: 'markdown',
    }), {
        Utilities: {
            Internal: {
                copyTextToClipboard(value) {
                    copied.push(value);
                },
            },
        },
    });

    shadow.querySelector('#mktero-copy').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(copied, ['# Copy me']);
    assert.equal(shadow.querySelector('#mktero-copy').textContent, 'Copied');
    view.destroy();
});

test('falls back to Zotero when the main-window Clipboard API rejects', async () => {
    const copied = [];
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        markdown: '# Copy after rejection',
        sourceKind: 'markdown',
    }), {
        Utilities: {
            Internal: {
                copyTextToClipboard(value) {
                    copied.push(value);
                },
            },
        },
    });
    view.ownerWindow = {
        navigator: {
            clipboard: {
                writeText: async () => {
                    throw new Error('NotAllowedError');
                },
            },
        },
        setTimeout,
        clearTimeout,
        URL: globalThis.URL,
        Blob: globalThis.Blob,
    };

    shadow.querySelector('#mktero-copy').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(copied, ['# Copy after rejection']);
    assert.equal(shadow.querySelector('#mktero-copy').textContent, 'Copied');
    view.destroy();
});

test('creates and revokes Blob URLs for cached MinerU images', () => {
    const created = [];
    const revoked = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            window.URL = {
                createObjectURL(blob) {
                    created.push(blob);
                    return 'blob:mktero-test-figure';
                },
                revokeObjectURL(url) {
                    revoked.push(url);
                },
            };
            window.Blob = globalThis.Blob;
        },
    });

    assert.equal(created.length, 1);
    assert.equal(
        shadow.querySelector('#mktero-preview img').getAttribute('src'),
        'blob:mktero-test-figure'
    );
    view.destroy();
    assert.deepEqual(revoked, ['blob:mktero-test-figure']);
});
