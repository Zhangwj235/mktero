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
});

test('keeps the Markdown mode toolbar compact and right aligned', async () => {
    const styles = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');

    assert.match(styles, /\.app-header\s*\{[^}]*justify-content: flex-end;/s);
    assert.match(styles, /\.app-header\s*\{[^}]*min-height: 46px;/s);
    assert.match(styles, /\.mode-switch button\s*\{[^}]*min-height: 28px;/s);
});
