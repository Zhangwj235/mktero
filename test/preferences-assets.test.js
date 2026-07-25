import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships MinerU token, cache preferences, and Markdown UI assets', async () => {
    const [prefs, pane, script, markdownView, tabPresenter, buildScript] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/preferences.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-tab-presenter.js', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.cacheEnabled", true\)/);
    assert.match(pane, /preference="extensions\.mktero\.mineruApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.cacheEnabled"/);
    assert.match(pane, /id="mktero-clear-cache"/);
    assert.match(pane, /MkteroPreferences\.init\(event\)/);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.match(markdownView, /'mktero-show-source'/);
    assert.doesNotMatch(markdownView, /'mktero-reparse'/);
    assert.match(markdownView, /__MKTERO_MARKDOWN_STYLES__/);
    assert.doesNotMatch(markdownView, /STYLESHEET_CACHE_KEY/);
    assert.match(markdownView, /bundled Markdown styles are unavailable/);
    assert.match(tabPresenter, /TAB_ICON = 'markdown'/);
    assert.match(buildScript, /ui\/preferences\.js/);
    assert.match(buildScript, /ui\/icons\/markdown\.svg/);
    assert.match(buildScript, /__MKTERO_MARKDOWN_STYLES__/);
    assert.doesNotMatch(buildScript, /copyText\('ui\/markdown\.css'/);
});
