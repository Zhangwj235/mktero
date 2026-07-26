import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMkteroProxyConfig,
    getMinerUCacheEnabled,
    getMinerUApiKey,
    MKTERO_PROXY_BYPASS_PREF,
    MKTERO_PROXY_ENABLED_PREF,
    MKTERO_PROXY_URL_PREF,
    MKTERO_PROXY_USE_SYSTEM_PREF,
    MINERU_API_KEY_PREF,
    MINERU_CACHE_ENABLED_PREF,
    MINERU_PREFERENCE_PANE_ID,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from '../src/config/mineru-preferences.js';

test('reads the mktero proxy mode and manual fields from preferences', () => {
    const values = new Map([
        [MKTERO_PROXY_ENABLED_PREF, true],
        [MKTERO_PROXY_USE_SYSTEM_PREF, false],
        [MKTERO_PROXY_URL_PREF, '  socks5h://user:pass@127.0.0.1:1080  '],
        [MKTERO_PROXY_BYPASS_PREF, ' localhost, 127.0.0.1, *.local '],
    ]);
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return values.get(key);
            },
        },
    };

    assert.deepEqual(getMkteroProxyConfig(zotero), {
        enabled: true,
        useSystem: false,
        url: 'socks5h://user:pass@127.0.0.1:1080',
        bypass: 'localhost, 127.0.0.1, *.local',
    });
    assert.deepEqual(calls, [...values.keys()].map(key => ({ key, global: true })));
});

test('reads and trims the configured MinerU API token', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return '  token-value  ';
            },
        },
    };

    assert.equal(getMinerUApiKey(zotero), 'token-value');
    assert.deepEqual(calls, [{ key: MINERU_API_KEY_PREF, global: true }]);
});

test('reads whether the local MinerU cache is enabled', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return false;
            },
        },
    };

    assert.equal(getMinerUCacheEnabled(zotero), false);
    assert.deepEqual(calls, [{ key: MINERU_CACHE_ENABLED_PREF, global: true }]);
});

test('registers and opens the Mktero preference pane', async () => {
    let registered;
    let opened;
    const zotero = {
        PreferencePanes: {
            register: async options => {
                registered = options;
                return options.id;
            },
        },
        Utilities: {
            Internal: {
                openPreferences: paneID => {
                    opened = paneID;
                },
            },
        },
    };

    const paneID = await registerMinerUPreferencesPane({
        zotero,
        pluginID: 'mktero@example.com',
        rootURI: 'resource://mktero/',
    });
    openMinerUPreferences(zotero);

    assert.equal(paneID, MINERU_PREFERENCE_PANE_ID);
    assert.deepEqual(registered, {
        pluginID: 'mktero@example.com',
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        src: 'resource://mktero/ui/preferences.xhtml',
        scripts: ['resource://mktero/ui/preferences.js'],
        stylesheets: ['resource://mktero/ui/preferences.css'],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
    assert.equal(opened, MINERU_PREFERENCE_PANE_ID);
});
