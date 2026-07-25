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
        editorFactory: options.editorFactory ?? createTestInlineEditor,
    });
    view.render(model);
    return { document, view, shadow: view.host.shadowRoot };
}

function createTestInlineEditor({ document, parent, initialMarkdown, onChange, onSaveRequest }) {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'true');
    content.textContent = initialMarkdown;
    content.addEventListener('input', () => onChange(content.textContent));
    content.addEventListener('keydown', event => {
        if (event.key?.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSaveRequest(content.textContent);
        }
    });
    editor.appendChild(content);
    parent.appendChild(editor);
    return {
        getMarkdown: () => content.textContent,
        setMarkdown(markdown) {
            content.textContent = markdown;
        },
        focus: () => content.focus(),
        refreshRendering: () => {},
        runCommand: () => false,
        destroy: () => editor.remove(),
    };
}

function editMarkdown(document, shadow, markdown) {
    const content = shadow.querySelector('.cm-content');
    content.textContent = markdown;
    content.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
}

test('uses one inline Markdown editor instead of separate preview and source modes', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nEditable.',
        sourceKind: 'markdown',
    }));

    assert.ok(shadow.querySelector('#mktero-editor .cm-editor'));
    assert.equal(shadow.querySelector('.cm-content').textContent, '# Paper\n\nEditable.');
    assert.equal(shadow.querySelector('#mktero-show-preview'), null);
    assert.equal(shadow.querySelector('#mktero-show-source'), null);
    assert.equal(shadow.querySelector('#mktero-preview'), null);
    assert.equal(shadow.querySelector('#mktero-source'), null);
    const saveStatus = shadow.querySelector('#mktero-save-status');
    assert.equal(shadow.querySelector('#mktero-save').textContent, '保存');
    view.destroy();
    assert.equal(saveStatus, null);
});

test('uses a Joplin-style editing toolbar to run inline editor commands', () => {
    const commands = [];
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Editable.',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.runCommand = command => {
                commands.push(command);
                return true;
            };
            return editor;
        },
    });
    const toolbar = shadow.querySelector('#mktero-editor-toolbar');

    assert.equal(toolbar.getAttribute('role'), 'toolbar');
    assert.equal(toolbar.getAttribute('aria-label'), 'Markdown 编辑工具');
    assert.deepEqual(
        [...toolbar.querySelectorAll('button[data-command]')]
            .map(button => button.getAttribute('data-command')),
        [
            'undo',
            'redo',
            'bold',
            'italic',
            'link',
            'code',
            'bullet-list',
            'numbered-list',
            'task-list',
            'heading',
            'horizontal-rule',
            'table',
        ]
    );
    assert.equal(shadow.querySelector('#mktero-show-preview'), null);
    assert.equal(shadow.querySelector('#mktero-show-source'), null);

    shadow.querySelector('button[data-command="bold"]').dispatchEvent(
        new document.defaultView.Event('click', { bubbles: true })
    );
    assert.deepEqual(commands, ['bold']);
    view.destroy();
});

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
    assert.equal(shadow.querySelector('#mktero-save-status'), null);
    assert.equal(shadow.querySelector('#mktero-title'), null);
    assert.equal(shadow.querySelector('#mktero-reparse'), null);
    assert.equal(shadow.querySelector('#mktero-copy'), null);
    assert.equal(shadow.querySelector('#mktero-show-preview'), null);
    assert.equal(shadow.querySelector('#mktero-show-source'), null);
    assert.equal(shadow.querySelector('.app-header').children.length, 2);
    assert.equal(shadow.querySelector('.source-actions').children.length, 1);
    assert.ok(shadow.querySelector('#mktero-editor-toolbar'));
    assert.ok(shadow.querySelector('#mktero-editor .cm-content'));
    assert.equal(shadow.querySelector('.markdown-editor').hidden, true);
    assert.equal(shadow.querySelector('#mktero-save').textContent, '保存');
    view.destroy();
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
    assert.equal(shadow.querySelector('.markdown-editor').hidden, false);
    assert.equal(shadow.querySelector('#mktero-status'), null);
    assert.equal(
        shadow.querySelector('.cm-content').textContent,
        '# Example Paper\n\nConverted.'
    );
    view.destroy();
});

test('edits Markdown directly in the inline rendered surface', () => {
    const model = createModel({
        title: 'Editable paper',
        status: 'ready',
        progress: 100,
        markdown: '# Original',
        sourceKind: 'markdown',
    });
    const { document, view, shadow } = createView(model);

    editMarkdown(document, shadow, '# Edited\n\nNow editable.');

    assert.equal(model.markdown, '# Original');
    assert.equal(shadow.querySelector('.cm-content').textContent, '# Edited\n\nNow editable.');
    assert.equal(
        shadow.querySelector('#mktero-save').getAttribute('data-state'),
        'unavailable'
    );
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
    const saveButton = shadow.querySelector('#mktero-save');

    assert.equal(saveButton.disabled, true);
    assert.equal(saveButton.getAttribute('data-state'), 'clean');

    editMarkdown(document, shadow, '# Edited');
    assert.equal(saveButton.disabled, false);
    assert.equal(saveButton.getAttribute('data-state'), 'dirty');

    saveButton.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(saved, ['# Edited']);
    assert.equal(model.markdown, '# Edited');
    assert.equal(saveButton.disabled, true);
    assert.equal(saveButton.getAttribute('data-state'), 'saved');
    assert.equal(shadow.querySelector('#mktero-save-status'), null);
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
    const saveButton = shadow.querySelector('#mktero-save');

    editMarkdown(document, shadow, '# Unsaved');
    saveButton.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(model.markdown, '# Original');
    assert.equal(shadow.querySelector('.cm-content').textContent, '# Unsaved');
    assert.equal(saveButton.disabled, false);
    assert.equal(saveButton.getAttribute('data-state'), 'error');
    assert.match(saveButton.getAttribute('title'), /disk full/);
    const saveError = shadow.querySelector('#mktero-save-error');
    view.destroy();

    assert.ok(saveError);
    assert.equal(saveError.hidden, false);
    assert.match(saveError.textContent, /disk full/);
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
    const saveButton = shadow.querySelector('#mktero-save');

    editMarkdown(document, shadow, '# Edited draft');

    assert.equal(saveButton.disabled, true);
    assert.equal(saveButton.getAttribute('data-state'), 'unavailable');
    assert.match(saveButton.getAttribute('title'), /无法保存/);
    view.destroy();
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
    let openLink;
    const { view } = createView(
        createModel({
            status: 'ready',
            markdown: '[MinerU](https://mineru.net)',
            sourceKind: 'markdown',
        }),
        { launchURL: url => launched.push(url) },
        {
            editorFactory(options) {
                openLink = options.openLink;
                return createTestInlineEditor(options);
            },
        }
    );
    openLink('https://mineru.net');

    assert.deepEqual(launched, ['https://mineru.net']);
    view.destroy();
});

test('ignores an empty Markdown fragment without treating it as a CSS selector', () => {
    let openLink;
    const { view } = createView(createModel({
        status: 'ready',
        markdown: '[Top](#)',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            openLink = options.openLink;
            return createTestInlineEditor(options);
        },
    });

    assert.doesNotThrow(() => openLink('#'));
    view.destroy();
});

test('creates and revokes Blob URLs for cached MinerU images', () => {
    const created = [];
    const revoked = [];
    let resolveImageURL;
    const { view } = createView(createModel({
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
        editorFactory(options) {
            resolveImageURL = options.resolveImageURL;
            return createTestInlineEditor(options);
        },
    });

    assert.equal(created.length, 1);
    assert.equal(resolveImageURL('images/figure.png'), 'blob:mktero-test-figure');
    view.destroy();
    assert.deepEqual(revoked, ['blob:mktero-test-figure']);
});

test('refreshes inline rendering when cached image assets change', () => {
    const firstAssets = [{
        path: 'images/figure.png',
        mimeType: 'image/png',
        data: new Uint8Array([1]),
    }];
    const model = createModel({
        status: 'ready',
        markdown: '![Figure](images/figure.png)',
        assets: firstAssets,
        sourceKind: 'markdown',
    });
    let refreshes = 0;
    const { view } = createView(model, {}, {
        configureWindow(window) {
            window.URL = {
                createObjectURL: () => `blob:mktero-${refreshes}`,
                revokeObjectURL: () => {},
            };
            window.Blob = globalThis.Blob;
        },
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.refreshRendering = () => refreshes++;
            return editor;
        },
    });

    assert.equal(refreshes, 1);
    view.render(model);
    assert.equal(refreshes, 1);

    view.render({
        ...model,
        assets: [{ ...firstAssets[0], data: new Uint8Array([2]) }],
    });
    assert.equal(refreshes, 2);
    view.destroy();
});
