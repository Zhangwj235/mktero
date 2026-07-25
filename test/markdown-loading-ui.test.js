import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships an accessible, visible loading UI for MinerU conversion', async () => {
    const [styles, script] = await Promise.all([
        readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
    ]);

    assert.match(script, /id: 'mktero-loading'/);
    assert.match(script, /role: 'status'/);
    assert.match(script, /id: 'mktero-loading-progress'/);
    assert.match(script, /id: 'mktero-loading-progress-label'/);
    assert.match(script, /attachShadow/);
    assert.match(styles, /@keyframes mktero-spin/);
    assert.match(styles, /\.loading-state--inline/);
    assert.match(styles, /\.mktero-tab-view/);
    assert.match(script, /createLoadingPresentation\(model\)/);
    assert.match(script, /loading-state--inline/);
    assert.doesNotMatch(script, /MinerU conversion|loading-eyebrow/);
    assert.doesNotMatch(styles, /\.loading-eyebrow/);
});

test('styles the Joplin-like Markdown toolbar as a compact grouped row', async () => {
    const styles = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');

    assert.match(styles, /\.app-header\s*\{[^}]*min-height: 40px;/s);
    assert.match(styles, /\.editor-toolbar\s*\{[^}]*display: flex;/s);
    assert.match(styles, /\.editor-toolbar\s*\{[^}]*overflow-x: auto;/s);
    assert.match(styles, /\.editor-toolbar-group:not\(:last-child\)\s*\{[^}]*border-right:/s);
    assert.match(styles, /\.editor-toolbar-button\s*\{[^}]*width: 30px;[^}]*height: 30px;/s);
    assert.match(styles, /\.markdown-editor-host\s*\{[^}]*min-height: 0;/s);
    assert.doesNotMatch(styles, /\.mode-switch/);
});

test('allows text selection in the inline rendered Markdown editor', async () => {
    const styles = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');

    assert.match(styles, /\.cm-content\s*\{[^}]*-moz-user-select: text;/s);
    assert.match(styles, /\.cm-content\s*\{[^}]*user-select: text;/s);
    assert.match(
        styles,
        /\.cm-content ::selection\s*\{[^}]*color: HighlightText;[^}]*background-color: Highlight;/s
    );
});
