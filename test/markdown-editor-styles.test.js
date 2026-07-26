import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

function ruleBody(selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = MARKDOWN_STYLES.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `Missing CSS rule: ${selector}`);
    return match[1];
}

test('article layout outranks the CodeMirror adopted base theme', () => {
    const scroller = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-scroller'
    );
    assert.match(scroller, /font-family:\s*inherit/);
    assert.match(scroller, /line-height:\s*inherit/);
    assert.match(scroller, /overflow-x:\s*hidden/);
    assert.match(scroller, /overflow-y:\s*auto/);

    const content = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-content'
    );
    assert.match(content, /width:\s*calc\(100% - 48px\)/);
    assert.match(content, /max-width:\s*960px/);
    assert.match(content, /flex:\s*0 0 auto/);
    assert.match(content, /padding:\s*32px 0 72px/);

    const line = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-line'
    );
    assert.match(line, /padding-inline:\s*0/);

    const heading = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-heading'
    );
    assert.match(heading, /font-weight:\s*700/);
    assert.match(heading, /line-height:\s*1\.3/);
});

test('wide Markdown tables stay inside the aligned reading column', () => {
    const tableFrame = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-table',
    ].join('\n'));
    assert.match(tableFrame, /width:\s*100%/);
    assert.match(tableFrame, /max-width:\s*100%/);
    assert.match(tableFrame, /overflow:\s*hidden/);
    assert.match(tableFrame, /border-radius:\s*8px/);

    const tables = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table',
    ].join('\n'));
    assert.match(tables, /table-layout:\s*fixed/);
    assert.match(tables, /font-size:\s*13px/);

    const cells = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table th,',
        '.markdown-editor-host > .cm-editor .cm-mktero-table td,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block th,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block td',
    ].join('\n'));
    assert.match(cells, /min-width:\s*0/);
    assert.match(cells, /overflow-wrap:\s*anywhere/);
    assert.match(cells, /word-break:\s*break-word/);
    assert.match(cells, /white-space:\s*normal/);
});

test('lays out a responsive scrollable outline beside the editor', () => {
    const workspace = ruleBody('.markdown-workspace');
    assert.match(workspace, /display:\s*flex/);
    assert.match(workspace, /min-width:\s*0/);

    const outline = ruleBody('.markdown-outline');
    assert.match(outline, /flex:\s*0 0 256px/);
    assert.match(outline, /border-right:\s*1px solid var\(--border\)/);

    const outlineList = ruleBody('.markdown-outline-list');
    assert.match(outlineList, /overflow-y:\s*auto/);

    const outlineLink = ruleBody('.markdown-outline-link');
    assert.match(
        outlineLink,
        /padding-left:\s*calc\(8px \+ var\(--outline-indent, 0px\)\)/
    );

    assert.match(
        MARKDOWN_STYLES,
        /@media\s*\(max-width:\s*760px\)[\s\S]*\.markdown-outline\s*\{[^}]*flex-basis:\s*min\(220px, 42vw\)/
    );
});

test('styles citation popups and temporary reference highlights', () => {
    const citation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-citation'
    );
    assert.match(citation, /color:\s*var\(--accent\)/);
    assert.match(citation, /cursor:\s*pointer/);

    const popup = ruleBody('.mktero-citation-popup');
    assert.match(popup, /position:\s*fixed/);
    assert.match(popup, /max-width:\s*min\(460px, calc\(100vw - 24px\)\)/);
    assert.match(popup, /z-index:\s*900/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-reference-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-reference-highlight 3s ease-out/);
});
