import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as preferencesUI from '../src/ui/preferences.js';

const { createPreferencesController, formatCacheStats } = preferencesUI;

test('formats cache statistics for the preferences pane', () => {
    assert.equal(formatCacheStats({ entries: 0, sizeBytes: 0 }), 'No cached documents');
    assert.equal(
        formatCacheStats({ entries: 2, sizeBytes: 1536 }),
        '2 cached documents, 1.5 KB'
    );
});

test('loads cache usage and clears it from the preferences pane', async () => {
    const status = createControl({ textContent: '' });
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
    let finishClear;
    const cache = {
        getStats: async () => stats,
        clear: async () => {
            clearCalls++;
            await new Promise(resolve => {
                finishClear = resolve;
            });
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
    assert.equal(status.attributes['aria-busy'], 'false');

    const clearing = button.listener();
    assert.equal(clearCalls, 1);
    assert.equal(button.disabled, true);
    assert.equal(status.textContent, 'Clearing cache...');
    assert.equal(status.attributes['aria-busy'], 'true');

    finishClear();
    await clearing;
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'No cached documents');
    assert.equal(status.attributes['aria-busy'], 'false');
});

test('restores cache controls when clearing the cache fails', async () => {
    const status = createControl({ textContent: '' });
    const button = createControl();
    const proxyElements = createProxyElements();
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return status;
            if (id === 'mktero-clear-cache') return button;
            return proxyElements[id];
        },
    };
    const failure = new Error('cache unavailable');
    let loggedError;
    const controller = createPreferencesController({
        document,
        zotero: { logError: error => { loggedError = error; } },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => { throw failure; },
        },
    });

    await controller.init();
    await button.dispatch('click');

    assert.equal(loggedError, failure);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'Cache could not be cleared');
    assert.equal(status.attributes['aria-busy'], 'false');
});

test('reveals and validates manual proxy fields when system proxy is disabled', async () => {
    const proxyElements = createProxyElements();
    const cacheStatus = createControl({ textContent: '' });
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
    assert.equal(proxyElements['mktero-system-proxy-row'].dataset.disabled, 'true');
    assert.equal(proxyElements['mktero-system-proxy-row'].attributes['aria-disabled'], 'true');
    assert.equal(proxyElements['mktero-proxy-use-system'].attributes['aria-expanded'], 'false');
    assert.equal(proxyElements['mktero-manual-proxy-fields'].hidden, true);
    assert.equal(proxyElements['mktero-manual-proxy-fields'].attributes['aria-hidden'], 'true');
    assert.equal(proxyElements['mktero-proxy-status'].hidden, true);

    proxyElements['mktero-proxy-enabled'].checked = true;
    proxyElements['mktero-proxy-enabled'].dispatch('change');
    assert.equal(proxyElements['mktero-proxy-use-system'].disabled, false);
    assert.equal(proxyElements['mktero-system-proxy-row'].dataset.disabled, 'false');
    assert.equal(proxyElements['mktero-system-proxy-row'].attributes['aria-disabled'], 'false');

    proxyElements['mktero-proxy-use-system'].checked = false;
    proxyElements['mktero-proxy-use-system'].dispatch('change');
    assert.equal(proxyElements['mktero-proxy-use-system'].attributes['aria-expanded'], 'true');
    assert.equal(proxyElements['mktero-manual-proxy-fields'].hidden, false);
    assert.equal(proxyElements['mktero-manual-proxy-fields'].attributes['aria-hidden'], 'false');
    assert.equal(proxyElements['mktero-proxy-url'].disabled, false);

    proxyElements['mktero-proxy-url'].value = 'ftp://127.0.0.1';
    proxyElements['mktero-proxy-url'].dispatch('input');
    assert.equal(proxyElements['mktero-proxy-status'].dataset.error, 'true');
    assert.equal(proxyElements['mktero-proxy-status'].hidden, false);
    assert.equal(proxyElements['mktero-proxy-url'].attributes['aria-invalid'], 'true');

    proxyElements['mktero-proxy-url'].value = 'http://127.0.0.1:7890';
    proxyElements['mktero-proxy-url'].dispatch('input');
    assert.equal(proxyElements['mktero-proxy-status'].dataset.error, 'false');
    assert.equal(proxyElements['mktero-proxy-status'].textContent, '');
    assert.equal(proxyElements['mktero-proxy-status'].hidden, true);
    assert.equal(proxyElements['mktero-proxy-url'].attributes['aria-invalid'], 'false');
});

test('restores the saved manual proxy layout after Zotero hydrates preferences', async () => {
    const proxyElements = createProxyElements();
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return createControl({ textContent: '' });
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

test('initializes an imported preferences fragment from Zotero capture-phase load', async () => {
    assert.equal(typeof preferencesUI.registerPreferencesPaneLoader, 'function');
    const dom = new JSDOM('<!doctype html><div id="mktero-preferences-pane"></div>');
    const pane = dom.window.document.getElementById('mktero-preferences-pane');
    let initializeCalls = 0;
    const dispose = preferencesUI.registerPreferencesPaneLoader({
        document: dom.window.document,
        initialize: async () => { initializeCalls++; },
    });

    let initialization;
    const load = new dom.window.Event('load');
    load.waitUntil = promise => { initialization = promise; };
    pane.dispatchEvent(load);
    await initialization;

    pane.dispatchEvent(new dom.window.Event('load'));
    assert.equal(initializeCalls, 1);
    dispose();

    const replacementPane = dom.window.document.createElement('div');
    replacementPane.id = 'mktero-preferences-pane';
    dom.window.document.body.append(replacementPane);
    replacementPane.dispatchEvent(new dom.window.Event('load'));
    assert.equal(initializeCalls, 1);
});

function createProxyElements() {
    return {
        'mktero-proxy-enabled': createControl({ checked: false }),
        'mktero-system-proxy-row': createControl({ dataset: {} }),
        'mktero-proxy-use-system': createControl({ checked: true }),
        'mktero-manual-proxy-fields': createControl({ hidden: false }),
        'mktero-proxy-url': createControl({ value: '' }),
        'mktero-proxy-bypass': createControl({ value: '' }),
        'mktero-proxy-status': createControl({ textContent: '', dataset: {}, hidden: false }),
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
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        dispatch(type) {
            return listeners.get(type)?.();
        },
    };
}
