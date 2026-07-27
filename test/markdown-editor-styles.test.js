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

test('wide Markdown tables scroll inside the aligned reading column', () => {
    const tableFrame = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-table',
    ].join('\n'));
    assert.match(tableFrame, /width:\s*100%/);
    assert.match(tableFrame, /max-width:\s*100%/);
    assert.match(tableFrame, /overflow-x:\s*auto/);
    assert.match(tableFrame, /overflow-y:\s*hidden/);
    assert.match(tableFrame, /overscroll-behavior-x:\s*contain/);
    assert.match(tableFrame, /scrollbar-width:\s*thin/);
    assert.match(tableFrame, /border-radius:\s*8px/);

    const tables = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table',
    ].join('\n'));
    assert.match(tables, /width:\s*100%/);
    assert.match(tables, /min-width:\s*100%/);
    assert.match(tables, /max-width:\s*none/);
    assert.match(tables, /table-layout:\s*auto/);
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

test('keeps inline math inside the prose line box', () => {
    const inlineMath = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-math'
    );
    assert.match(inlineMath, /display:\s*inline-block/);
    assert.match(inlineMath, /line-height:\s*1\.2/);
    assert.match(inlineMath, /vertical-align:\s*-0\.1em/);

    const displayMath = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-math-display'
    );
    assert.doesNotMatch(displayMath, /line-height/);
});

test('styles academic figure captions as distinct labels', () => {
    const caption = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure figcaption'
    );
    assert.match(caption, /padding:\s*8px 10px/);
    assert.match(caption, /border-left:\s*3px solid/);
    assert.match(caption, /border-radius:\s*4px/);
    assert.match(caption, /background:\s*color-mix\(/);
    assert.match(caption, /font-family:\s*ui-sans-serif/);
    assert.match(caption, /font-size:\s*12px/);
    assert.match(caption, /letter-spacing:\s*0/);

    const label = ruleBody(
        '.markdown-editor-host > .cm-editor .mktero-figure-label'
    );
    assert.match(label, /color:\s*var\(--text\)/);
    assert.match(label, /font-weight:\s*650/);
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
    assert.match(popup, /--citation-popup-surface:\s*#fff/);
    assert.match(popup, /--citation-popup-text:\s*#24292f/);
    assert.match(popup, /--citation-popup-border:\s*#d8dee4/);
    assert.match(popup, /--citation-popup-hover:\s*#f3f6fb/);
    assert.match(popup, /--citation-popup-accent:\s*#2f6feb/);
    assert.match(popup, /background:\s*var\(--citation-popup-surface\)/);

    const popupItem = ruleBody('.mktero-citation-popup-item');
    assert.match(popupItem, /padding:\s*10px 12px/);
    assert.match(popupItem, /border-radius:\s*7px/);

    const popupItemHover = ruleBody([
        '.mktero-citation-popup-item:hover,',
        '.mktero-citation-popup-item:focus-visible',
    ].join('\n'));
    assert.match(popupItemHover, /background:\s*var\(--citation-popup-hover\)/);
    assert.match(
        popupItemHover,
        /box-shadow:\s*inset 3px 0 0 var\(--citation-popup-accent\)/
    );

    assert.match(
        MARKDOWN_STYLES,
        /\n\n\.mktero-citation-popup-item:focus-visible\s*\{[^}]*outline:\s*2px solid color-mix\([\s\S]*?var\(--citation-popup-accent\) 35%[^}]*\}/
    );

    const superscriptCitation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-citation-superscript'
    );
    assert.match(superscriptCitation, /font-size:\s*0\.75em/);
    assert.match(superscriptCitation, /line-height:\s*1/);
    assert.match(superscriptCitation, /vertical-align:\s*super/);

    const affiliationMarker = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-affiliation-marker'
    );
    assert.match(affiliationMarker, /color:\s*var\(--accent\)/);
    assert.match(affiliationMarker, /font-weight:\s*650/);
    assert.doesNotMatch(affiliationMarker, /cursor:\s*pointer/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-reference-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-reference-highlight 3s ease-out/);
});
