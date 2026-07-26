import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships MinerU token, cache preferences, and Markdown UI assets', async () => {
    const [
        prefs,
        pane,
        script,
        bootstrap,
        markdownView,
        tabPresenter,
        buildScript,
    ] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/preferences.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-tab-presenter.js', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.cacheEnabled", true\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.proxyEnabled", false\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.proxyUseSystem", true\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.proxyURL", ""\)/);
    assert.match(
        prefs,
        /pref\("extensions\.mktero\.proxyBypass", "localhost, 127\.0\.0\.1"\)/
    );
    assert.match(pane, /preference="extensions\.mktero\.mineruApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.cacheEnabled"/);
    assert.match(pane, /preference="extensions\.mktero\.proxyEnabled"/);
    assert.match(pane, /preference="extensions\.mktero\.proxyUseSystem"/);
    assert.match(pane, /preference="extensions\.mktero\.proxyURL"/);
    assert.match(pane, /preference="extensions\.mktero\.proxyBypass"/);
    assert.match(pane, /socks5h:\/\/user:pass@127\.0\.0\.1:1080/);
    assert.match(pane, /id="mktero-clear-cache"/);
    assert.match(pane, /MkteroPreferences\.init\(event\)/);
    const visiblePreferenceText = pane.replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(visiblePreferenceText, /mineru/i);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.match(bootstrap, /createZoteroProxyTransport/);
    assert.match(bootstrap, /fetch: proxyTransport\.fetch/);
    assert.match(bootstrap, /MKTERO_PROXY_CONFIG_INVALID/);
    assert.match(markdownView, /createInlineMarkdownEditor/);
    assert.doesNotMatch(markdownView, /'mktero-show-source'/);
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

test('ships the proxy preferences as a responsive settings card with switches', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.match(pane, /class="mktero-settings-card"/);
    assert.equal((pane.match(/class="mktero-switch-input"/g) || []).length, 2);
    assert.equal((pane.match(/class="mktero-switch" aria-hidden="true"/g) || []).length, 2);
    assert.equal((pane.match(/role="switch"/g) || []).length, 2);
    assert.match(
        pane,
        /id="mktero-proxy-use-system"[\s\S]*aria-controls="mktero-manual-proxy-fields"/
    );
    assert.match(
        pane,
        /id="mktero-proxy-url"[\s\S]*aria-describedby="mktero-proxy-url-help mktero-proxy-status"/
    );
    assert.match(
        pane,
        /id="mktero-proxy-bypass"[\s\S]*aria-describedby="mktero-proxy-bypass-help"/
    );
    assert.match(styles, /\.mktero-settings-card\s*\{[\s\S]*border-radius:/);
    assert.match(styles, /\.mktero-switch-input:checked\s*\+\s*\.mktero-switch/);
    assert.match(styles, /\.mktero-switch::before/);
    assert.match(styles, /@media\s*\(max-width:/);
});
