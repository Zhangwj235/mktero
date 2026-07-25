import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

test('keeps Markdown as the source of truth and saves it through one editor surface', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const changes = [];
    const saves = [];
    const initialMarkdown = '# Paper\n\n**Unchanged** source.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: markdown => changes.push(markdown),
        onSaveRequest: markdown => saves.push(markdown),
    });

    assert.ok(document.querySelector('.cm-editor'));
    assert.equal(editor.getMarkdown(), initialMarkdown);
    assert.deepEqual(changes, []);

    const updatedMarkdown = '# Updated\n\n$E = mc^2$';
    editor.setMarkdown(updatedMarkdown);
    assert.equal(editor.getMarkdown(), updatedMarkdown);
    assert.deepEqual(changes, []);

    document.querySelector('.cm-content').dispatchEvent(new dom.window.KeyboardEvent(
        'keydown',
        { key: 's', ctrlKey: true, bubbles: true, cancelable: true }
    ));
    assert.deepEqual(saves, [updatedMarkdown]);

    editor.destroy();
    assert.doesNotThrow(() => editor.destroy());
    assert.equal(document.querySelector('.cm-editor'), null);
    dom.window.close();
});

test('renders inactive Markdown formatting and formulas without rewriting source', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\n**Bold** and $E = mc^2$.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(document.querySelector('.cm-mktero-strong').textContent, 'Bold');
    assert.ok(document.querySelector('.cm-mktero-math math'));
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\*\*Bold\*\*/);

    editor.destroy();
    dom.window.close();
});

test('renders formulas in headings and link labels', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '## Result $E = mc^2$',
        '',
        '[Equation $x^2$](https://example.com)',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.equal(document.querySelectorAll('.cm-mktero-math math').length, 2);
    assert.ok(document.querySelector('.cm-mktero-link.cm-mktero-math'));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders paper tables, cached images, page markers, and safe links inline', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const markdown = [
        'Intro',
        '',
        '| Source | Value |',
        '| --- | --- |',
        '| [MinerU](https://mineru.net) | 42 |',
        '',
        '![Figure](images/figure.png)',
        '',
        '<!-- zotero-page: 2 -->',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: source => source === 'images/figure.png'
            ? 'blob:mktero-figure'
            : null,
        openLink: url => opened.push(url),
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.equal(document.querySelector('.cm-mktero-table table th').textContent, 'Source');
    assert.equal(
        document.querySelector('.cm-mktero-image img').getAttribute('src'),
        'blob:mktero-figure'
    );
    assert.match(document.querySelector('.cm-mktero-html-block').textContent, /Page 2/);

    document.querySelector('.cm-mktero-table a').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, ['https://mineru.net']);
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('edits a rendered GFM table cell while keeping the document Markdown-backed', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const changes = [];
    const markdown = [
        'Before',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Score | 42 |',
        '',
        'After',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: value => changes.push(value),
        onSaveRequest: assert.fail,
    });
    const valueCell = document.querySelector('.cm-mktero-table tbody td:last-child');

    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    valueCell.textContent = '43';
    valueCell.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: true }));

    assert.equal(editor.getMarkdown(), markdown.replace('| Score | 42 |', '| Score | 43 |'));
    assert.equal(changes.at(-1), editor.getMarkdown());

    editor.destroy();
    dom.window.close();
});

test('commits a rendered table cell before handling its save shortcut', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const saves = [];
    const markdown = [
        'Before',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Score | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: () => {},
        onSaveRequest: value => saves.push(value),
    });
    const valueCell = document.querySelector('.cm-mktero-table tbody td:last-child');

    valueCell.textContent = '43';
    valueCell.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
    }));

    assert.match(editor.getMarkdown(), /\| Score \| 43 \|/);
    assert.deepEqual(saves, [editor.getMarkdown()]);

    editor.destroy();
    dom.window.close();
});

test('applies inline toolbar formatting to a rendered table cell selection', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Paper | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const nameCell = document.querySelector('.cm-mktero-table tbody td:first-child');
    nameCell.focus();
    const range = document.createRange();
    range.selectNodeContents(nameCell);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    assert.equal(editor.runCommand('bold'), true);
    assert.equal(
        editor.getMarkdown(),
        markdown.replace('| Paper | 42 |', '| **Paper** | 42 |')
    );
    assert.doesNotMatch(editor.getMarkdown(), /^\*\*粗体文字\*\*/);

    const formattedCell = document.querySelector(
        '.cm-mktero-table tbody td:first-child'
    );
    formattedCell.focus();
    const formattedRange = document.createRange();
    formattedRange.selectNodeContents(formattedCell);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(formattedRange);
    const formattedMarkdown = editor.getMarkdown();
    assert.equal(editor.runCommand('heading'), false);
    assert.equal(editor.getMarkdown(), formattedMarkdown);

    editor.destroy();
    dom.window.close();
});

test('commits a pending rendered table edit before toolbar undo', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Paper | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const nameCell = document.querySelector('.cm-mktero-table tbody td:first-child');
    nameCell.focus();
    nameCell.textContent = 'Changed';

    assert.equal(editor.runCommand('undo'), true);
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        document.querySelector('.cm-mktero-table tbody td:first-child').textContent,
        'Paper'
    );

    editor.destroy();
    dom.window.close();
});

test('routes table toolbar commands through the editor shadow root', () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const shadowRoot = document.querySelector('#host').attachShadow({ mode: 'open' });
    const editorHost = document.createElement('div');
    shadowRoot.appendChild(editorHost);
    const markdown = [
        'Intro',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Paper | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: editorHost,
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const nameCell = shadowRoot.querySelector(
        '.cm-mktero-table tbody td:first-child'
    );
    nameCell.focus();
    const range = document.createRange();
    range.selectNodeContents(nameCell);
    shadowRoot.getSelection = () => ({
        rangeCount: 1,
        getRangeAt: () => range,
    });

    assert.equal(editor.runCommand('bold'), true);
    assert.equal(
        editor.getMarkdown(),
        markdown.replace('| Paper | 42 |', '| **Paper** | 42 |')
    );

    editor.destroy();
    dom.window.close();
});

test('renders quotes, lists, task controls, and dividers while retaining Markdown', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const changes = [];
    const markdown = [
        'Intro',
        '',
        '> Quoted finding',
        '',
        '- [ ] Verify result',
        '- Supporting item',
        '',
        '---',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: value => changes.push(value),
        onSaveRequest: assert.fail,
    });

    assert.equal(document.querySelector('.cm-mktero-blockquote').textContent, 'Quoted finding');
    assert.equal(document.querySelector('.cm-mktero-list-bullet').textContent, '•');
    const checkbox = document.querySelector('.cm-mktero-task input');
    assert.equal(checkbox.checked, false);
    assert.ok(document.querySelector('.cm-mktero-divider hr'));

    checkbox.click();
    assert.match(editor.getMarkdown(), /- \[x\] Verify result/);
    assert.equal(changes.at(-1), editor.getMarkdown());

    editor.destroy();
    dom.window.close();
});

test('opens an inline Markdown link through the host on modifier-click', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Intro\n\n[Open paper](https://example.com/paper)',
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, ['https://example.com/paper']);

    editor.destroy();
    dom.window.close();
});

test('does not open an unsafe inline Markdown link', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Intro\n\n[Unsafe](javascript:alert(1))',
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, []);

    editor.destroy();
    dom.window.close();
});

test('opens all reference, autolink, and bare URL Markdown links', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: [
            'Intro',
            '',
            '[Reference][paper]',
            '',
            '[Collapsed][]',
            '',
            '[Shortcut]',
            '',
            '<https://example.com/autolink>',
            '',
            'https://example.com/bare',
            '',
            '[paper]: https://example.com/reference',
            '[collapsed]: https://example.com/collapsed',
            '[shortcut]: https://example.com/shortcut',
        ].join('\n'),
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    for (const link of document.querySelectorAll('.cm-mktero-link')) {
        link.dispatchEvent(new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        }));
    }
    assert.deepEqual(opened, [
        'https://example.com/reference',
        'https://example.com/collapsed',
        'https://example.com/shortcut',
        'https://example.com/autolink',
        'https://example.com/bare',
    ]);
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\[paper\]:/);

    editor.destroy();
    dom.window.close();
});

test('refreshes rendered assets without changing the Markdown document', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n![Figure](images/figure.png)';
    let imageURL = null;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => imageURL,
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.equal(document.querySelector('.cm-mktero-image img'), null);
    imageURL = 'blob:mktero-refreshed-figure';
    editor.refreshRendering();

    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        document.querySelector('.cm-mktero-image img').getAttribute('src'),
        imageURL
    );

    editor.destroy();
    dom.window.close();
});

test('renders a cached image inside paragraph text', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\nSee ![Figure](images/figure.png) for details.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-inline-figure',
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.equal(
        document.querySelector('.cm-mktero-image-inline img').getAttribute('src'),
        'blob:mktero-inline-figure'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('allows rendered block text to be selected without revealing its source', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n```text\nselect this text\n```';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });
    const code = document.querySelector('.cm-mktero-code-block pre');
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    const mouseDown = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    code.dispatchEvent(mouseDown);
    code.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(mouseDown.defaultPrevented, false);
    assert.match(document.getSelection().toString(), /select this text/);
    assert.ok(document.querySelector('.cm-mktero-code-block'));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders an inactive indented Markdown code block', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n    const answer = 42;';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
        onChange: assert.fail,
        onSaveRequest: assert.fail,
    });

    assert.match(
        document.querySelector('.cm-mktero-code-block pre').textContent,
        /const answer = 42;/
    );
    assert.equal(editor.getMarkdown(), markdown);

    document.querySelector('.cm-mktero-code-block').dispatchEvent(
        new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    assert.equal(document.querySelector('.cm-mktero-code-block'), null);
    assert.match(document.querySelector('.cm-content').textContent, /    const answer/);

    editor.destroy();
    dom.window.close();
});

test('supports editors owned by two Zotero windows at the same time', () => {
    const firstDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const secondDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const firstEditor = createInlineMarkdownEditor({
        parent: firstDOM.window.document.querySelector('#editor'),
        initialMarkdown: '# First',
        resolveImageURL: () => null,
    });
    let secondEditor;

    assert.doesNotThrow(() => {
        secondEditor = createInlineMarkdownEditor({
            parent: secondDOM.window.document.querySelector('#editor'),
            initialMarkdown: '# Second',
            resolveImageURL: () => null,
        });
    });
    firstEditor.setMarkdown('# First updated');
    secondEditor.setMarkdown('# Second updated');
    assert.equal(firstEditor.getMarkdown(), '# First updated');
    assert.equal(secondEditor.getMarkdown(), '# Second updated');

    secondEditor.destroy();
    firstEditor.destroy();
    secondDOM.window.close();
    firstDOM.window.close();
});

test('applies toolbar bold formatting and can undo it', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const changes = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Plain text',
        resolveImageURL: () => null,
        onChange: markdown => changes.push(markdown),
    });

    assert.equal(editor.runCommand('bold'), true);
    assert.equal(editor.getMarkdown(), '**粗体文字**Plain text');
    assert.equal(changes.at(-1), '**粗体文字**Plain text');

    assert.equal(editor.runCommand('undo'), true);
    assert.equal(editor.getMarkdown(), 'Plain text');

    editor.destroy();
    dom.window.close();
});

test('toggles toolbar formatting around the selected Markdown text', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    dom.window.Range.prototype.getClientRects = () => [];
    dom.window.Range.prototype.getBoundingClientRect = () => ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Plain text',
        resolveImageURL: () => null,
    });
    const content = document.querySelector('.cm-content');
    for (let index = 0; index < 5; index++) {
        content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        }));
    }

    editor.runCommand('bold');
    assert.equal(editor.getMarkdown(), '**Plain** text');
    editor.runCommand('bold');
    assert.equal(editor.getMarkdown(), 'Plain text');

    editor.runCommand('bold');
    editor.runCommand('italic');
    assert.equal(editor.getMarkdown(), '***Plain*** text');
    editor.runCommand('italic');
    assert.equal(editor.getMarkdown(), '**Plain** text');

    editor.destroy();
    dom.window.close();
});

test('applies Joplin-style inline formatting toolbar commands', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="italic"></div><div id="link"></div><div id="code"></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const createEditor = id => createInlineMarkdownEditor({
        parent: document.querySelector(id),
        initialMarkdown: 'Plain text',
        resolveImageURL: () => null,
    });
    const italicEditor = createEditor('#italic');
    const linkEditor = createEditor('#link');
    const codeEditor = createEditor('#code');

    assert.equal(italicEditor.runCommand('italic'), true);
    assert.equal(italicEditor.getMarkdown(), '*斜体文字*Plain text');
    assert.equal(linkEditor.runCommand('link'), true);
    assert.equal(linkEditor.getMarkdown(), '[链接文字](https://)Plain text');
    assert.equal(codeEditor.runCommand('code'), true);
    assert.equal(codeEditor.getMarkdown(), '`代码`Plain text');

    codeEditor.destroy();
    linkEditor.destroy();
    italicEditor.destroy();
    dom.window.close();
});

test('applies Joplin-style block formatting toolbar commands', () => {
    const dom = new JSDOM([
        '<!doctype html>',
        '<div id="bullet"></div>',
        '<div id="number"></div>',
        '<div id="task"></div>',
        '<div id="heading"></div>',
    ].join(''), { pretendToBeVisual: true });
    const { document } = dom.window;
    const createEditor = id => createInlineMarkdownEditor({
        parent: document.querySelector(id),
        initialMarkdown: 'Item',
        resolveImageURL: () => null,
    });
    const bulletEditor = createEditor('#bullet');
    const numberEditor = createEditor('#number');
    const taskEditor = createEditor('#task');
    const headingEditor = createEditor('#heading');

    assert.equal(bulletEditor.runCommand('bullet-list'), true);
    assert.equal(bulletEditor.getMarkdown(), '- Item');
    assert.equal(numberEditor.runCommand('numbered-list'), true);
    assert.equal(numberEditor.getMarkdown(), '1. Item');
    assert.equal(taskEditor.runCommand('task-list'), true);
    assert.equal(taskEditor.getMarkdown(), '- [ ] Item');
    assert.equal(headingEditor.runCommand('heading'), true);
    assert.equal(headingEditor.getMarkdown(), '## Item');

    headingEditor.destroy();
    taskEditor.destroy();
    numberEditor.destroy();
    bulletEditor.destroy();
    dom.window.close();
});

test('inserts horizontal rules and Markdown tables from the toolbar', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="rule"></div><div id="table"></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const createEditor = id => createInlineMarkdownEditor({
        parent: document.querySelector(id),
        initialMarkdown: 'Plain text',
        resolveImageURL: () => null,
    });
    const ruleEditor = createEditor('#rule');
    const tableEditor = createEditor('#table');

    assert.equal(ruleEditor.runCommand('horizontal-rule'), true);
    assert.equal(ruleEditor.getMarkdown(), '---\n\nPlain text');
    assert.equal(tableEditor.runCommand('table'), true);
    assert.equal(tableEditor.getMarkdown(), [
        '| 列 1 | 列 2 |',
        '| --- | --- |',
        '|  |  |',
        '',
        'Plain text',
    ].join('\n'));

    tableEditor.destroy();
    ruleEditor.destroy();
    dom.window.close();
});
