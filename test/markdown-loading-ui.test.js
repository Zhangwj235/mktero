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
