import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
    createMinerUCacheKey,
    createZoteroMarkdownCache,
} from '../src/cache/markdown-cache.js';

test('aborts live AI SDK requests across bootstrap translation lifecycles', {
    timeout: 15_000,
}, async t => {
    const previousGlobals = captureGlobals([
        'Zotero',
        'IOUtils',
        'PathUtils',
        'fetch',
        'startup',
        'shutdown',
        'Services',
        '__MKTERO_MARKDOWN_STYLES__',
    ]);
    const profilePath = await mkdtemp(path.join(
        os.tmpdir(),
        'mktero-translation-bootstrap-'
    ));
    const pdfPath = path.join(profilePath, 'paper.pdf');
    const pdfData = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    await writeFile(pdfPath, pdfData);
    const ioUtils = createNodeIOUtils();
    const pathUtils = {
        join: path.join,
        parent: path.dirname,
        filename: path.basename,
        tempDir: path.join(profilePath, 'tmp'),
    };
    const chatSignals = [];
    const errors = [];
    let toolbarHandler;
    const mainWindow = createMainWindow(AbortController, []);
    const item = {
        id: 42,
        attachmentFilename: 'paper.pdf',
        parentItem: null,
        isPDFAttachment: () => true,
        getDisplayTitle: () => 'Paper',
        getFilePathAsync: async () => pdfPath,
        getAnnotations: () => [],
    };
    const preferences = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.aiEnabled', true],
        ['extensions.mktero.aiProvider', 'custom'],
        ['extensions.mktero.aiProtocol', 'openai-chat-completions'],
        ['extensions.mktero.aiApiBase', 'https://ai.example.com/v1'],
        ['extensions.mktero.aiApiKey', 'test-token'],
        ['extensions.mktero.aiModel', 'test-chat'],
        ['extensions.mktero.aiTargetLanguage', 'zh-CN'],
        ['extensions.mktero.aiRequestTimeoutMs', 120_000],
        ['extensions.mktero.aiMaxOutputTokens', 2_048],
    ]);
    const observerService = createObserverService();
    globalThis.Zotero = {
        version: '9.0.6',
        locale: 'en-US',
        uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath },
        Session: { state: { windows: [] } },
        Prefs: { get: key => preferences.get(key) ?? '' },
        Items: {
            getAsync: async () => item,
            loadDataTypes: async () => {},
        },
        PreferencePanes: {
            register: async options => options.id,
            unregister() {},
        },
        Reader: {
            registerEventListener(_type, handler) {
                toolbarHandler = handler;
            },
        },
        getMainWindow: () => mainWindow,
        debug() {},
        logError(error) { errors.push(error); },
    };
    globalThis.IOUtils = ioUtils;
    globalThis.PathUtils = pathUtils;
    globalThis.Services = { obs: observerService };
    globalThis.__MKTERO_MARKDOWN_STYLES__ = readFileSync(
        new URL('../ui/markdown.css', import.meta.url),
        'utf8'
    );
    globalThis.fetch = async (url, { signal } = {}) => {
        if (!String(url).endsWith('/chat/completions')) {
            throw new Error('offline MinerU test transport');
        }
        chatSignals.push(signal);
        return new Promise((_, reject) => {
            const abort = () => {
                const error = signal.reason || new Error('aborted');
                if (!error.name) error.name = 'AbortError';
                reject(error);
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        });
    };

    t.after(async () => {
        globalThis.shutdown?.();
        mainWindow.document.defaultView.close();
        restoreGlobals(previousGlobals);
        await rm(profilePath, { recursive: true, force: true });
    });

    const cacheKey = await createMinerUCacheKey(pdfData);
    await createZoteroMarkdownCache({
        zotero: globalThis.Zotero,
        ioUtils,
        pathUtils,
    }).put(cacheKey, {
        markdown: '# Paper\n\nTranslate this paragraph.',
        assets: [],
        sourceMap: [],
        extractedPages: 1,
        totalPages: 1,
    });
    await import('../src/bootstrap.js?translation-lifecycle-regression');
    await globalThis.startup({
        id: 'mktero@tenglvjun.github.io',
        rootURI: 'resource://mktero/',
    });
    const toolbarButtons = [];
    toolbarHandler({
        reader: { type: 'pdf', itemID: 42 },
        doc: createToolbarDocument(),
        append: button => toolbarButtons.push(button),
    });

    toolbarButtons[0].click();
    let root = await waitFor(() => mainWindow.tabRoot('tab-1'));
    let shadow = root.shadowRoot;
    await waitFor(() => !shadow.querySelector(
        '#mktero-translate-document'
    )?.disabled);

    startTranslation(shadow);
    const exitSignal = await waitFor(() => chatSignals[0]);
    shadow.querySelector('#mktero-translate-document').click();
    await waitFor(() => exitSignal.aborted);
    await waitFor(() => shadow.querySelector(
        '#mktero-translate-document'
    )?.getAttribute('aria-busy') === 'false');

    startTranslation(shadow);
    const cacheClearSignal = await waitFor(() => chatSignals[1]);
    observerService.notifyObservers(null, 'mktero-cache-cleared');
    await waitFor(() => cacheClearSignal.aborted);
    await waitFor(() => shadow.querySelector(
        '#mktero-translate-document'
    )?.getAttribute('aria-busy') === 'false');
    const translationViewButtons = [...shadow.querySelectorAll(
        '[data-translation-view]'
    )];
    assert.equal(
        translationViewButtons.every(button => button.disabled),
        true
    );
    assert.equal(
        shadow.querySelector('[data-translation-view="original"]')
            ?.getAttribute('aria-pressed'),
        'true'
    );

    startTranslation(shadow);
    const reparseSignal = await waitFor(() => chatSignals[2]);
    shadow.querySelector('#mktero-reparse').click();
    await waitFor(() => reparseSignal.aborted);
    await waitFor(() => !shadow.querySelector('#mktero-reparse')?.disabled);
    await waitFor(() => shadow.querySelector(
        '#mktero-translate-document'
    )?.getAttribute('aria-busy') === 'false');

    startTranslation(shadow);
    const closeSignal = await waitFor(() => chatSignals[3]);
    mainWindow.Zotero_Tabs.close('tab-1');
    await waitFor(() => closeSignal.aborted);

    toolbarButtons[0].click();
    root = await waitFor(() => mainWindow.tabRoot('tab-2'));
    shadow = root.shadowRoot;
    await waitFor(() => !shadow.querySelector(
        '#mktero-translate-document'
    )?.disabled);
    startTranslation(shadow);
    const shutdownSignal = await waitFor(() => chatSignals[4]);
    globalThis.shutdown();
    await waitFor(() => shutdownSignal.aborted);
    assert.equal(observerService.count('mktero-cache-cleared'), 0);

    assert.deepEqual(
        [exitSignal, cacheClearSignal, reparseSignal, closeSignal, shutdownSignal]
            .map(signal => signal.aborted),
        [true, true, true, true, true]
    );
    assert.ok(errors.every(error => !String(error).includes('test-token')));
});

test('uses the Zotero window AbortController when the plugin sandbox has none', {
    timeout: 5_000,
}, async t => {
    const NativeAbortController = globalThis.AbortController;
    const previousGlobals = {
        Zotero: globalThis.Zotero,
        IOUtils: globalThis.IOUtils,
        PathUtils: globalThis.PathUtils,
        startup: globalThis.startup,
        shutdown: globalThis.shutdown,
        __MKTERO_MARKDOWN_STYLES__: globalThis.__MKTERO_MARKDOWN_STYLES__,
    };
    const alerts = [];
    const debugLogs = [];
    const actionsTagsEvents = [];
    let toolbarHandler;
    let resolveOpenedPreferences;
    const openedPreferences = new Promise(resolve => {
        resolveOpenedPreferences = resolve;
    });
    const mainWindow = createMainWindow(NativeAbortController, alerts);
    globalThis.Zotero = {
        version: '9.0.6',
        uiReadyPromise: Promise.resolve(),
        Profile: { dir: '/tmp/mktero-test-profile' },
        Session: { state: { windows: [] } },
        Prefs: {
            get(key) {
                if (key === 'extensions.mktero.cacheEnabled') return false;
                return '';
            },
        },
        Items: {
            getAsync: async () => ({
                id: 42,
                attachmentFilename: 'paper.pdf',
                parentItem: null,
                isPDFAttachment: () => true,
                getDisplayTitle: () => 'Paper',
                getFilePathAsync: async () => '/tmp/paper.pdf',
            }),
        },
        ActionsTags: {
            api: {
                actionManager: {
                    async dispatchActionByEvent(event, args) {
                        actionsTagsEvents.push({ event, args });
                    },
                },
            },
        },
        PreferencePanes: {
            register: async options => options.id,
            unregister() {},
        },
        Utilities: {
            Internal: {
                openPreferences(id) {
                    resolveOpenedPreferences(id);
                },
            },
        },
        Reader: {
            registerEventListener(_type, handler) {
                toolbarHandler = handler;
            },
        },
        getMainWindow: () => mainWindow,
        debug(message) {
            debugLogs.push(message);
        },
        logError() {},
    };
    globalThis.IOUtils = {
        exists: async () => false,
        getChildren: async () => [],
        read: async () => new Uint8Array([1]),
        stat: async () => ({ size: 0 }),
    };
    globalThis.PathUtils = {
        join: path.join,
        parent: path.dirname,
        filename: path.basename,
    };
    globalThis.__MKTERO_MARKDOWN_STYLES__ = readFileSync(
        new URL('../ui/markdown.css', import.meta.url),
        'utf8'
    );
    delete globalThis.AbortController;

    t.after(() => {
        globalThis.shutdown?.();
        mainWindow.document.defaultView.close();
        globalThis.AbortController = NativeAbortController;
        for (const [name, value] of Object.entries(previousGlobals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });

    await import('../src/bootstrap.js?abort-controller-regression');
    await globalThis.startup({
        id: 'mktero@tenglvjun.github.io',
        rootURI: 'resource://mktero/',
    });
    const appended = [];
    toolbarHandler({
        reader: { type: 'pdf', itemID: 42 },
        doc: createToolbarDocument(),
        append: button => appended.push(button),
    });

    appended[0].click();

    assert.deepEqual(alerts, []);
    assert.equal(await openedPreferences, 'mktero-preferences');
    assert.ok(debugLogs.some(message => message.includes('conversion started for item 42')));
    assert.ok(debugLogs.some(message => message.includes('conversion failed for item 42')));
    assert.deepEqual(actionsTagsEvents, []);
});

function createMainWindow(AbortController, alerts) {
    const { document } = new JSDOM(
        '<!doctype html><html><body></body></html>',
        { pretendToBeVisual: true }
    ).window;
    const tabs = new Map();
    let nextTabID = 1;
    const Zotero_Tabs = {
        add(options) {
            const id = `tab-${nextTabID++}`;
            const children = [];
            tabs.set(id, { options, children });
            return {
                id,
                container: {
                    appendChild(child) {
                        children.push(child);
                    },
                },
            };
        },
        select() {},
        rename() {},
        getState: () => [],
        close(tabID) {
            tabs.get(tabID)?.options.onClose?.();
            tabs.delete(tabID);
        },
    };
    return {
        AbortController,
        Zotero_Tabs,
        document,
        tabRoot(tabID) {
            return tabs.get(tabID)?.children[0] || null;
        },
        alert(message) {
            alerts.push(message);
        },
    };
}

function createObserverService() {
    const listeners = new Map();
    return {
        addObserver(observer, topic) {
            listeners.set(topic, observer);
        },
        removeObserver(observer, topic) {
            if (listeners.get(topic) === observer) listeners.delete(topic);
        },
        notifyObservers(subject, topic) {
            listeners.get(topic)?.observe(subject, topic);
        },
        count(topic) {
            return Number(listeners.has(topic));
        },
    };
}

function startTranslation(shadow) {
    const trigger = shadow.querySelector('#mktero-translate-document');
    assert.ok(trigger);
    trigger.click();
}

async function waitFor(read, { attempts = 100 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the bootstrap test state');
}

function captureGlobals(names) {
    return new Map(names.map(name => [name, globalThis[name]]));
}

function restoreGlobals(values) {
    for (const [name, value] of values) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
    }
}

function createNodeIOUtils() {
    const atomicWrite = async (filePath, data, temporaryPath) => {
        if (!temporaryPath) {
            await writeFile(filePath, data);
            return;
        }
        await writeFile(temporaryPath, data);
        await rename(temporaryPath, filePath);
    };
    return {
        async exists(filePath) {
            try {
                await access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        makeDirectory: (filePath, options = {}) => mkdir(filePath, {
            recursive: options.ignoreExisting !== false,
        }),
        read: async filePath => new Uint8Array(await readFile(filePath)),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath))
            .map(name => path.join(filePath, name)),
        stat: async filePath => {
            const value = await stat(filePath);
            return {
                type: value.isDirectory() ? 'directory' : 'regular',
                size: value.size,
            };
        },
        remove: (filePath, options = {}) => rm(filePath, {
            recursive: Boolean(options.recursive),
            force: Boolean(options.ignoreAbsent),
        }),
        write: (filePath, data, options = {}) => (
            atomicWrite(filePath, data, options.tmpPath)
        ),
        writeUTF8: (filePath, data, options = {}) => (
            atomicWrite(filePath, data, options.tmpPath)
        ),
    };
}

function createToolbarDocument() {
    return {
        createElement() {
            let click;
            return {
                dataset: {},
                children: [],
                setAttribute() {},
                appendChild(child) {
                    this.children.push(child);
                    return child;
                },
                addEventListener(type, handler) {
                    if (type === 'click') click = handler;
                },
                click() {
                    click?.();
                },
            };
        },
        createElementNS(_namespace, tagName) {
            return this.createElement(tagName);
        },
    };
}
