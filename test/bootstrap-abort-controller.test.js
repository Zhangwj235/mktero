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
    sha256Hex,
} from '../src/cache/markdown-cache.js';
import {
    MarkdownTranslationService,
    TRANSLATION_PROMPT_VERSION,
} from '../src/ai/markdown-translation-service.js';

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
            ?.getAttribute('aria-checked'),
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

test('switches open tabs only to complete cached target-language translations', {
    timeout: 10_000,
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
        'mktero-translation-language-'
    ));
    const pdfPath = path.join(profilePath, 'paper.pdf');
    const pdfData = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const markdown = '# Paper';
    await writeFile(pdfPath, pdfData);
    const ioUtils = createNodeIOUtils();
    const pathUtils = {
        join: path.join,
        parent: path.dirname,
        filename: path.basename,
        tempDir: path.join(profilePath, 'tmp'),
    };
    const preferences = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.aiEnabled', true],
        ['extensions.mktero.aiProvider', 'custom'],
        ['extensions.mktero.aiProtocol', 'openai-chat-completions'],
        ['extensions.mktero.aiApiBase', 'https://ai.example.com/v1'],
        ['extensions.mktero.aiApiKey', 'test-token'],
        ['extensions.mktero.aiModel', 'test-chat'],
        ['extensions.mktero.aiTargetLanguage', 'ko-KR'],
        ['extensions.mktero.aiStreaming', false],
    ]);
    const preferenceObservers = new Map();
    const unregisteredObservers = [];
    const errors = [];
    let toolbarHandler;
    const providerSignals = [];
    const mainWindow = createMainWindow(AbortController, []);
    const secondMainWindow = createMainWindow(AbortController, []);
    let activeMainWindow = mainWindow;
    globalThis.Zotero = {
        version: '9.0.6',
        locale: 'en-US',
        uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath },
        Session: { state: { windows: [] } },
        Prefs: {
            get: key => preferences.get(key) ?? '',
            registerObserver(key, callback) {
                const id = `${key}-${preferenceObservers.size}`;
                preferenceObservers.set(key, { callback, id });
                return id;
            },
            unregisterObserver(id) {
                unregisteredObservers.push(id);
                for (const [key, observer] of preferenceObservers) {
                    if (observer.id === id) preferenceObservers.delete(key);
                }
            },
        },
        Items: {
            getAsync: async itemID => ({
                id: itemID,
                attachmentFilename: 'paper.pdf',
                parentItem: null,
                isPDFAttachment: () => true,
                getDisplayTitle: () => 'Paper',
                getFilePathAsync: async () => pdfPath,
                getAnnotations: () => [],
            }),
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
        getMainWindow: () => activeMainWindow,
        debug() {},
        logError(error) { errors.push(error); },
    };
    globalThis.IOUtils = ioUtils;
    globalThis.PathUtils = pathUtils;
    globalThis.Services = { obs: createObserverService() };
    globalThis.fetch = async (_url, { signal } = {}) => {
        providerSignals.push(signal);
        return new Promise((_, reject) => {
            const abort = () => reject(signal.reason || Object.assign(
                new Error('aborted'),
                { name: 'AbortError' }
            ));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        });
    };
    globalThis.__MKTERO_MARKDOWN_STYLES__ = readFileSync(
        new URL('../ui/markdown.css', import.meta.url),
        'utf8'
    );

    t.after(async () => {
        globalThis.shutdown?.();
        mainWindow.document.defaultView.close();
        secondMainWindow.document.defaultView.close();
        restoreGlobals(previousGlobals);
        await rm(profilePath, { recursive: true, force: true });
    });

    const cacheKey = await createMinerUCacheKey(pdfData);
    const cache = createZoteroMarkdownCache({
        zotero: globalThis.Zotero,
        ioUtils,
        pathUtils,
    });
    await cache.put(cacheKey, {
        markdown,
        assets: [],
        sourceMap: [],
        extractedPages: 1,
        totalPages: 1,
    });
    await putCachedTranslation(cache, cacheKey, markdown, {
        targetLanguage: 'zh-CN',
        translatedMarkdown: '# \u8bba\u6587',
    });
    await putCachedTranslation(cache, cacheKey, markdown, {
        targetLanguage: 'ja-JP',
        translatedMarkdown: '# \u8ad6\u6587',
    });
    await putCachedTranslation(cache, cacheKey, markdown, {
        targetLanguage: 'fr-FR',
        translatedMarkdown: '# Paper',
        partial: true,
    });

    await import('../src/bootstrap.js?translation-language-cache-regression');
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
    const root = await waitFor(() => mainWindow.tabRoot('tab-1'));
    const shadow = root.shadowRoot;
    const translatedMode = shadow.querySelector(
        '[data-translation-view="translated"]'
    );
    const translate = shadow.querySelector('#mktero-translate-document');
    await waitFor(() => translatedMode.textContent === 'Simplified Chinese');
    assert.equal(
        shadow.querySelector('[data-translation-view="original"]')
            .getAttribute('aria-checked'),
        'true'
    );
    assert.equal(translate.hidden, false);
    translatedMode.click();
    const languageOptions = () => [...shadow.querySelectorAll(
        '[data-translation-language]'
    )];
    assert.deepEqual(languageOptions().map(option => (
        option.getAttribute('data-translation-language')
    )), ['zh-CN', 'ja-JP']);
    languageOptions()[0].click();
    await waitFor(() => shadow.textContent.includes('\u8bba\u6587'));

    translatedMode.click();
    languageOptions()[1].click();
    await waitFor(() => translatedMode.textContent === 'Japanese');
    assert.match(shadow.textContent, /\u8ad6\u6587/);
    assert.equal(preferences.get('extensions.mktero.aiTargetLanguage'), 'ko-KR');
    assert.equal(translate.hidden, false);
    assert.equal(providerSignals.length, 0);

    const originalGetCached = MarkdownTranslationService.prototype
        .getCachedDocumentTranslation;
    t.after(() => {
        MarkdownTranslationService.prototype.getCachedDocumentTranslation =
            originalGetCached;
    });
    let releaseChineseCacheRead;
    let resolveChineseCacheReadStarted;
    const chineseCacheReadStarted = new Promise(resolve => {
        resolveChineseCacheReadStarted = resolve;
    });
    const chineseCacheReadGate = new Promise(resolve => {
        releaseChineseCacheRead = resolve;
    });
    let delayChineseCacheRead = true;
    MarkdownTranslationService.prototype.getCachedDocumentTranslation =
        async function (options) {
            if (delayChineseCacheRead && options.targetLanguage === 'zh-CN') {
                resolveChineseCacheReadStarted();
                await chineseCacheReadGate;
            }
            return originalGetCached.call(this, options);
        };
    preferences.set('extensions.mktero.aiTargetLanguage', 'zh-CN');
    const chineseChange = preferenceObservers.get(
        'extensions.mktero.aiTargetLanguage'
    ).callback('zh-CN');
    await chineseCacheReadStarted;
    translatedMode.click();
    languageOptions().find(option => (
        option.getAttribute('data-translation-language') === 'ja-JP'
    )).click();
    await waitFor(() => translatedMode.textContent === 'Japanese');
    delayChineseCacheRead = false;
    releaseChineseCacheRead();
    await chineseChange;
    MarkdownTranslationService.prototype.getCachedDocumentTranslation =
        originalGetCached;
    assert.equal(translatedMode.textContent, 'Japanese');
    assert.match(shadow.textContent, /\u8ad6\u6587/);
    assert.equal(translate.hidden, false);

    activeMainWindow = secondMainWindow;
    const secondToolbarButtons = [];
    toolbarHandler({
        reader: { type: 'pdf', itemID: 43 },
        doc: createToolbarDocument(),
        append: button => secondToolbarButtons.push(button),
    });
    secondToolbarButtons[0].click();
    const secondRoot = await waitFor(() => secondMainWindow.tabRoot('tab-1'));
    const secondShadow = secondRoot.shadowRoot;
    const secondTranslatedMode = secondShadow.querySelector(
        '[data-translation-view="translated"]'
    );
    await waitFor(() => secondTranslatedMode.textContent
        === 'Simplified Chinese');
    secondTranslatedMode.click();
    secondShadow.querySelector(
        '[data-translation-language="zh-CN"]'
    ).click();
    await waitFor(() => secondShadow.textContent.includes('\u8bba\u6587'));

    preferences.set('extensions.mktero.aiTargetLanguage', 'ja-JP');
    const japaneseChange = preferenceObservers.get(
        'extensions.mktero.aiTargetLanguage'
    ).callback('ja-JP');
    assert.equal(translate.hidden, true);
    assert.equal(translatedMode.textContent, 'Japanese');
    assert.match(shadow.textContent, /\u8ad6\u6587/);
    await japaneseChange;
    assert.equal(translatedMode.textContent, 'Japanese');
    assert.equal(translate.hidden, true);
    assert.equal(translatedMode.getAttribute('aria-checked'), 'true');
    assert.match(shadow.textContent, /\u8ad6\u6587/);
    assert.equal(secondTranslatedMode.textContent, 'Japanese');
    assert.equal(secondTranslatedMode.getAttribute('aria-checked'), 'true');
    assert.match(secondShadow.textContent, /\u8ad6\u6587/);

    const originalTranslateDocument = MarkdownTranslationService.prototype
        .translateDocument;
    const originalListCached = MarkdownTranslationService.prototype
        .listCachedDocumentTranslations;
    let releaseCachedLanguageRefresh;
    let resolveCachedLanguageRefreshStarted;
    const cachedLanguageRefreshStarted = new Promise(resolve => {
        resolveCachedLanguageRefreshStarted = resolve;
    });
    const cachedLanguageRefreshGate = new Promise(resolve => {
        releaseCachedLanguageRefresh = resolve;
    });
    t.after(() => {
        releaseCachedLanguageRefresh();
        MarkdownTranslationService.prototype.translateDocument =
            originalTranslateDocument;
        MarkdownTranslationService.prototype.listCachedDocumentTranslations =
            originalListCached;
    });
    MarkdownTranslationService.prototype.translateDocument =
        async function (options) {
            await putCachedTranslation(cache, cacheKey, markdown, {
                targetLanguage: 'ja-JP',
                translatedMarkdown: markdown,
                partial: true,
            });
            return originalGetCached.call(this, {
                documentKey: options.documentKey,
                markdown: options.markdown,
                targetLanguage: 'ja-JP',
            });
        };
    MarkdownTranslationService.prototype.listCachedDocumentTranslations =
        async function (options) {
            resolveCachedLanguageRefreshStarted();
            await cachedLanguageRefreshGate;
            return originalListCached.call(this, options);
        };
    shadow.querySelector('#mktero-document-actions').click();
    shadow.querySelector('#mktero-retranslate-document').click();
    await cachedLanguageRefreshStarted;
    translatedMode.click();
    assert.deepEqual(languageOptions().map(option => (
        option.getAttribute('data-translation-language')
    )), ['zh-CN']);
    releaseCachedLanguageRefresh();
    await waitFor(() => shadow.querySelector(
        '.markdown-translation-failure-navigation'
    ).hidden === false);
    MarkdownTranslationService.prototype.translateDocument =
        originalTranslateDocument;
    MarkdownTranslationService.prototype.listCachedDocumentTranslations =
        originalListCached;

    preferences.set('extensions.mktero.aiTargetLanguage', 'fr-FR');
    const frenchChange = preferenceObservers.get(
        'extensions.mktero.aiTargetLanguage'
    ).callback('fr-FR');
    assert.equal(translate.hidden, false);
    await frenchChange;
    assert.equal(translatedMode.textContent, 'Japanese');
    assert.equal(translatedMode.getAttribute('aria-checked'), 'true');
    assert.doesNotMatch(shadow.textContent, /\u8ad6\u6587/);

    translate.click();
    const frenchSignal = await waitFor(() => providerSignals[0]);
    preferences.set('extensions.mktero.aiTargetLanguage', 'es-ES');
    const spanishChange = preferenceObservers.get(
        'extensions.mktero.aiTargetLanguage'
    ).callback('es-ES');
    assert.equal(translate.getAttribute('aria-label'), 'Translate document');
    assert.equal(translate.getAttribute('aria-busy'), 'false');
    assert.equal(translatedMode.textContent, 'Japanese');
    assert.doesNotMatch(shadow.textContent, /\u8ad6\u6587/);
    await spanishChange;
    assert.equal(frenchSignal.aborted, true);
    assert.ok(errors.some(error => error?.name === 'AbortError'));
    assert.ok(errors.every(error => !String(error).includes('test-token')));

    const targetObserverID = preferenceObservers.get(
        'extensions.mktero.aiTargetLanguage'
    ).id;
    globalThis.shutdown();
    assert.ok(unregisteredObservers.includes(targetObserverID));
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

async function putCachedTranslation(cache, documentKey, source, {
    targetLanguage,
    translatedMarkdown,
    partial = false,
}) {
    const translationKey = await sha256Hex(new TextEncoder().encode(
        JSON.stringify({
            documentKey,
            source,
            provider: 'custom',
            protocol: 'openai-chat-completions',
            apiBase: 'https://ai.example.com/v1',
            model: 'test-chat',
            reasoning: 'none',
            targetLanguage,
            promptVersion: TRANSLATION_PROMPT_VERSION,
        })
    ));
    const blockID = 'translation-0-0-7-heading';
    await cache.putTranslation(documentKey, translationKey, {
        translatedMarkdown,
        comparisonMarkdown: `${source}\n\n${translatedMarkdown}`,
        blocks: [{ id: blockID, markdown: translatedMarkdown }],
        model: 'test-chat',
        targetLanguage,
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial,
        failedBlocks: partial
            ? [{ id: blockID, message: 'Incomplete translation' }]
            : [],
    });
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
