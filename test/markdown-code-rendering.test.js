import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

function waitForAsyncRendering() {
    return new Promise(resolve => setImmediate(resolve));
}

test('renders a language toolbar, copies code, and asynchronously highlights tokens', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const copied = [];
    const markdown = [
        '```javascript',
        'const answer = 42;',
        '```',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copyCode: code => copied.push(code),
    });

    const block = document.querySelector('.cm-mktero-code-block');
    const code = block.querySelector('code');
    const copyButton = block.querySelector('[data-action="copy-code"]');
    assert.equal(
        block.querySelector('.cm-mktero-code-language').textContent,
        'javascript'
    );
    assert.ok(copyButton);
    assert.equal(code.dataset.highlighted, undefined);

    copyButton.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    await waitForAsyncRendering();
    assert.deepEqual(copied, ['const answer = 42;\n']);
    assert.equal(copyButton.textContent, 'Copied');

    await waitForAsyncRendering();
    assert.equal(code.dataset.highlighted, 'true');
    assert.ok(code.querySelector('.cm-mktero-code-token'));
    assert.equal(code.textContent, 'const answer = 42;\n');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('keeps untrusted code as text and skips copying blank blocks', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const copied = [];
    const source = '<img src=x onerror="alert(1)">';
    const markdown = [
        '```javascript',
        source,
        '```',
        '',
        '```python',
        '   ',
        '```',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copyCode: code => copied.push(code),
    });

    const blocks = [...document.querySelectorAll('.cm-mktero-code-block')];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].querySelector('img'), null);
    assert.equal(blocks[0].querySelector('code').textContent, `${source}\n`);
    assert.ok(blocks[0].querySelector('[data-action="copy-code"]'));
    assert.equal(blocks[1].querySelector('[data-action="copy-code"]'), null);

    await waitForAsyncRendering();
    await waitForAsyncRendering();
    assert.equal(blocks[0].querySelector('code').textContent, `${source}\n`);
    assert.equal(editor.getMarkdown(), markdown);
    assert.deepEqual(copied, []);

    editor.destroy();
    dom.window.close();
});
