import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferencesController, formatCacheStats } from '../src/ui/preferences.js';

test('formats cache statistics for the preferences pane', () => {
    assert.equal(formatCacheStats({ entries: 0, sizeBytes: 0 }), 'No cached documents');
    assert.equal(
        formatCacheStats({ entries: 2, sizeBytes: 1536 }),
        '2 cached documents, 1.5 KB'
    );
});

test('loads cache usage and clears it from the preferences pane', async () => {
    const status = { textContent: '' };
    const button = {
        disabled: false,
        addEventListener(_type, listener) {
            this.listener = listener;
        },
    };
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return status;
            if (id === 'mktero-clear-cache') return button;
            return proxyElements[id];
        },
    };
    const proxyElements = createProxyElements();
    let stats = { entries: 2, sizeBytes: 1536 };
    let clearCalls = 0;
    const cache = {
        getStats: async () => stats,
        clear: async () => {
            clearCalls++;
            stats = { entries: 0, sizeBytes: 0 };
        },
    };
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache,
    });

    await controller.init();
    assert.equal(status.textContent, '2 cached documents, 1.5 KB');

    await button.listener();
    assert.equal(clearCalls, 1);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'No cached documents');
});

test('reveals and validates manual proxy fields when system proxy is disabled', async () => {
    const proxyElements = createProxyElements();
    const cacheStatus = { textContent: '' };
    const clearButton = createControl();
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return cacheStatus;
            if (id === 'mktero-clear-cache') return clearButton;
            return proxyElements[id];
        },
    };
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    assert.equal(proxyElements['mktero-proxy-use-system'].disabled, true);
    assert.equal(proxyElements['mktero-manual-proxy-fields'].hidden, true);

    proxyElements['mktero-proxy-enabled'].checked = true;
    proxyElements['mktero-proxy-enabled'].dispatch('change');
    assert.equal(proxyElements['mktero-proxy-use-system'].disabled, false);

    proxyElements['mktero-proxy-use-system'].checked = false;
    proxyElements['mktero-proxy-use-system'].dispatch('change');
    assert.equal(proxyElements['mktero-manual-proxy-fields'].hidden, false);
    assert.equal(proxyElements['mktero-proxy-url'].disabled, false);

    proxyElements['mktero-proxy-url'].value = 'ftp://127.0.0.1';
    proxyElements['mktero-proxy-url'].dispatch('input');
    assert.equal(proxyElements['mktero-proxy-status'].dataset.error, 'true');

    proxyElements['mktero-proxy-url'].value = 'http://127.0.0.1:7890';
    proxyElements['mktero-proxy-url'].dispatch('input');
    assert.equal(proxyElements['mktero-proxy-status'].dataset.error, 'false');
    assert.equal(proxyElements['mktero-proxy-status'].textContent, '');
});

test('restores the saved manual proxy layout after Zotero hydrates preferences', async () => {
    const proxyElements = createProxyElements();
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return { textContent: '' };
            if (id === 'mktero-clear-cache') return createControl();
            return proxyElements[id];
        },
    };
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });
    await controller.init();

    proxyElements['mktero-proxy-enabled'].checked = true;
    proxyElements['mktero-proxy-use-system'].checked = false;
    proxyElements['mktero-proxy-url'].value = 'socks5h://127.0.0.1:1080';
    proxyElements['mktero-proxy-enabled'].dispatch('syncfrompreference');
    proxyElements['mktero-proxy-use-system'].dispatch('syncfrompreference');
    proxyElements['mktero-proxy-url'].dispatch('syncfrompreference');

    assert.equal(proxyElements['mktero-proxy-use-system'].disabled, false);
    assert.equal(proxyElements['mktero-manual-proxy-fields'].hidden, false);
    assert.equal(proxyElements['mktero-proxy-url'].disabled, false);
    assert.equal(proxyElements['mktero-proxy-status'].dataset.error, 'false');
});

function createProxyElements() {
    return {
        'mktero-proxy-enabled': createControl({ checked: false }),
        'mktero-proxy-use-system': createControl({ checked: true }),
        'mktero-manual-proxy-fields': { hidden: false },
        'mktero-proxy-url': createControl({ value: '' }),
        'mktero-proxy-bypass': createControl({ value: '' }),
        'mktero-proxy-status': { textContent: '', dataset: {} },
    };
}

function createControl(properties = {}) {
    const listeners = new Map();
    return {
        disabled: false,
        ...properties,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatch(type) {
            listeners.get(type)?.();
        },
    };
}
