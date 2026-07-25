import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

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
        cacheKey: null,
        preserveContent: false,
        warnings: [],
        error: '',
        onReparse: null,
        onSave: null,
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
        stylesheetText: options.stylesheetText ?? MARKDOWN_STYLES,
    });
    view.render(model);
    return { document, view, shadow: view.host.shadowRoot };
}

test('mounts the Markdown UI in an isolated inline shadow root', () => {
    const { view, shadow } = createView();

    assert.equal(view.root.localName, 'div');
    assert.equal(view.root.getAttribute('role'), 'region');
    assert.equal(shadow.querySelector('link[rel="stylesheet"]'), null);
    assert.equal(
        shadow.querySelector('style[data-mktero-styles="embedded"]').textContent,
        MARKDOWN_STYLES
    );
    assert.equal(shadow.querySelector('#mktero-loading').getAttribute('role'), 'status');
    assert.equal(shadow.querySelector('#mktero-status'), null);
    assert.equal(shadow.querySelector('#mktero-title'), null);
    assert.equal(shadow.querySelector('#mktero-reparse'), null);
    assert.equal(shadow.querySelector('#mktero-copy'), null);
    assert.equal(shadow.querySelector('#mktero-show-preview').textContent, '预览');
    assert.equal(shadow.querySelector('#mktero-show-source').textContent, '查看源文件');
    assert.equal(shadow.querySelector('.app-header').children.length, 1);
    assert.equal(shadow.querySelector('#mktero-show-preview svg').getAttribute('width'), '16');
    assert.equal(shadow.querySelector('#mktero-show-preview svg').getAttribute('height'), '16');
    assert.equal(shadow.querySelector('#mktero-show-source svg').getAttribute('width'), '16');
    assert.equal(shadow.querySelector('#mktero-show-source svg').getAttribute('height'), '16');
    assert.equal(shadow.querySelector('#mktero-source').closest('.source-editor') !== null, true);
    assert.equal(shadow.querySelector('#mktero-save').textContent, '保存');
});

test('embeds bundled CSS directly in the Markdown shadow root', () => {
    const stylesheetText = ':host { color: rgb(12 34 56); }';
    const { shadow } = createView(createModel(), {}, { stylesheetText });

    assert.equal(shadow.querySelector('link[rel="stylesheet"]'), null);
    assert.equal(
        shadow.querySelector('style[data-mktero-styles="embedded"]').textContent,
        stylesheetText
    );
});

test('fails clearly when bundled Markdown CSS is unavailable', () => {
    assert.throws(
        () => createView(createModel(), {}, { stylesheetText: '' }),
        /bundled Markdown styles are unavailable/
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
    assert.equal(shadow.querySelector('#mktero-status'), null);
    assert.match(
        shadow.querySelector('#mktero-preview').innerHTML,
        /<h1>Example Paper<\/h1>[\s\S]*<p>Converted\.<\/p>/
    );
    assert.equal(shadow.querySelector('#mktero-source').localName, 'textarea');
    assert.equal(shadow.querySelector('#mktero-source').value, '# Example Paper\n\nConverted.');
});

test('edits Markdown source and renders the edited value in preview mode', () => {
    const model = createModel({
        title: 'Editable paper',
        status: 'ready',
        progress: 100,
        markdown: '# Original',
        sourceKind: 'markdown',
    });
    const { document, view, shadow } = createView(model);
    const source = shadow.querySelector('#mktero-source');

    shadow.querySelector('#mktero-show-source').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );

    assert.equal(shadow.querySelector('#mktero-preview').hidden, true);
    assert.equal(source.hidden, false);
    assert.equal(source.hasAttribute('readonly'), false);

    source.value = '# Edited\n\nNow editable.';
    source.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    shadow.querySelector('#mktero-show-preview').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );

    assert.equal(model.markdown, '# Original');
    assert.equal(source.hidden, true);
    assert.equal(shadow.querySelector('#mktero-preview').hidden, false);
    assert.equal(shadow.querySelector('#mktero-preview h1').textContent, 'Edited');
    assert.equal(shadow.querySelector('#mktero-preview p').textContent, 'Now editable.');
    view.destroy();
});

test('saves an edited Markdown draft and reports the saved state', async () => {
    const saved = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Original',
        sourceKind: 'markdown',
        cacheKey: 'a'.repeat(64),
        onSave: async markdown => saved.push(markdown),
    });
    const { document, view, shadow } = createView(model);
    const source = shadow.querySelector('#mktero-source');
    const saveButton = shadow.querySelector('#mktero-save');
    const saveStatus = shadow.querySelector('#mktero-save-status');

    shadow.querySelector('#mktero-show-source').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    assert.equal(saveButton.disabled, true);
    assert.equal(saveStatus.getAttribute('data-state'), 'clean');

    source.value = '# Edited';
    source.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    assert.equal(saveButton.disabled, false);
    assert.equal(saveStatus.getAttribute('data-state'), 'dirty');

    saveButton.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(saved, ['# Edited']);
    assert.equal(model.markdown, '# Edited');
    assert.equal(saveButton.disabled, true);
    assert.equal(saveStatus.getAttribute('data-state'), 'saved');
    assert.match(saveStatus.textContent, /已保存/);
    view.destroy();
});

test('keeps an edited Markdown draft when saving fails', async () => {
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Original',
        sourceKind: 'markdown',
        cacheKey: 'a'.repeat(64),
        onSave: async () => { throw new Error('disk full'); },
    });
    const { document, view, shadow } = createView(model);
    const source = shadow.querySelector('#mktero-source');
    const saveButton = shadow.querySelector('#mktero-save');
    const saveStatus = shadow.querySelector('#mktero-save-status');

    shadow.querySelector('#mktero-show-source').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    source.value = '# Unsaved';
    source.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    saveButton.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(model.markdown, '# Original');
    assert.equal(source.value, '# Unsaved');
    assert.equal(saveButton.disabled, false);
    assert.equal(saveStatus.getAttribute('data-state'), 'error');
    assert.match(saveStatus.textContent, /disk full/);
    view.destroy();
});

test('explains when Markdown edits cannot be saved to a local cache entry', () => {
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Draft only',
        sourceKind: 'markdown',
        onSave: async () => assert.fail('save must remain unavailable'),
    });
    const { document, view, shadow } = createView(model);
    const source = shadow.querySelector('#mktero-source');
    const saveButton = shadow.querySelector('#mktero-save');
    const saveStatus = shadow.querySelector('#mktero-save-status');

    shadow.querySelector('#mktero-show-source').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    source.value = '# Edited draft';
    source.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

    assert.equal(saveButton.disabled, true);
    assert.equal(saveStatus.getAttribute('data-state'), 'unavailable');
    assert.match(saveStatus.textContent, /无法保存/);
    view.destroy();
});

test('renders ready Markdown without XML innerHTML assignment in Zotero', () => {
    const { view, shadow } = createView();
    const preview = shadow.querySelector('#mktero-preview');
    let assignedInnerHTML = false;
    Object.defineProperty(preview, 'innerHTML', {
        configurable: true,
        set(value) {
            assignedInnerHTML = true;
            if (/<img\b[^>]*(?<!\/)\s*>/i.test(value)) {
                throw new SyntaxError('An invalid or illegal string was specified');
            }
        },
    });

    assert.doesNotThrow(() => view.render(createModel({
        status: 'ready',
        markdown: '# XML-safe rendering\n\n![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceKind: 'markdown',
    })));
    assert.equal(assignedInnerHTML, false);
    assert.equal(preview.querySelector('h1').textContent, 'XML-safe rendering');
    assert.match(preview.querySelector('img').getAttribute('src'), /^blob:/);
});

test('imports MathML markup into the Zotero view', () => {
    const { view, shadow } = createView();

    view.render(createModel({
        status: 'ready',
        markdown: 'Author $^{a,b,*}$',
        sourceKind: 'markdown',
        cacheHit: true,
    }));

    const math = shadow.querySelector('#mktero-preview math');
    assert.ok(math);
    assert.equal(math.getAttribute('xmlns'), 'http://www.w3.org/1998/Math/MathML');
    assert.ok(math.querySelector('msup'));
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
