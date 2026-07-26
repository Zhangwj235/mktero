import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import { parseProxyURL } from '../platform/proxy-transport.js';

export function registerPreferencesPaneLoader({ document, initialize }) {
    const initializations = new WeakMap();
    const handleLoad = event => {
        const pane = event.target;
        if (pane?.id !== 'mktero-preferences-pane') return;
        let initialization = initializations.get(pane);
        if (!initialization) {
            initialization = Promise.resolve().then(() => initialize(event));
            initializations.set(pane, initialization);
        }
        event.waitUntil?.(initialization);
    };
    document.addEventListener('load', handleLoad, true);
    return () => document.removeEventListener('load', handleLoad, true);
}

export function createPreferencesController({ document, zotero, cache }) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');
    const proxyEnabled = document.getElementById('mktero-proxy-enabled');
    const systemProxyRow = document.getElementById('mktero-system-proxy-row');
    const proxyUseSystem = document.getElementById('mktero-proxy-use-system');
    const manualProxyFields = document.getElementById('mktero-manual-proxy-fields');
    const proxyURL = document.getElementById('mktero-proxy-url');
    const proxyBypass = document.getElementById('mktero-proxy-bypass');
    const proxyStatus = document.getElementById('mktero-proxy-status');

    async function refresh() {
        status.setAttribute('aria-busy', 'true');
        try {
            status.textContent = formatCacheStats(await cache.getStats());
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = 'Cache information unavailable';
        }
        finally {
            status.setAttribute('aria-busy', 'false');
        }
    }

    async function clear() {
        clearButton.disabled = true;
        status.setAttribute('aria-busy', 'true');
        status.textContent = 'Clearing cache...';
        try {
            await cache.clear();
            await refresh();
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = 'Cache could not be cleared';
        }
        finally {
            clearButton.disabled = false;
            status.setAttribute('aria-busy', 'false');
        }
    }

    function syncProxyFields() {
        const enabled = proxyEnabled.checked;
        const manual = enabled && !proxyUseSystem.checked;
        proxyUseSystem.disabled = !enabled;
        systemProxyRow.dataset.disabled = String(!enabled);
        systemProxyRow.setAttribute('aria-disabled', String(!enabled));
        proxyUseSystem.setAttribute('aria-expanded', String(manual));
        manualProxyFields.hidden = !manual;
        manualProxyFields.setAttribute('aria-hidden', String(!manual));
        proxyURL.disabled = !manual;
        proxyBypass.disabled = !manual;
        proxyURL.setAttribute('aria-invalid', 'false');
        proxyStatus.dataset.error = 'false';
        proxyStatus.textContent = '';
        proxyStatus.hidden = true;
        if (!manual) return;
        try {
            parseProxyURL(proxyURL.value);
        }
        catch (error) {
            proxyURL.setAttribute('aria-invalid', 'true');
            proxyStatus.dataset.error = 'true';
            proxyStatus.textContent = error.message;
            proxyStatus.hidden = false;
        }
    }

    return {
        async init() {
            clearButton.addEventListener('click', clear);
            proxyEnabled.addEventListener('change', syncProxyFields);
            proxyUseSystem.addEventListener('change', syncProxyFields);
            proxyURL.addEventListener('input', syncProxyFields);
            for (const field of [
                proxyEnabled,
                proxyUseSystem,
                proxyURL,
                proxyBypass,
            ]) {
                field.addEventListener('syncfrompreference', syncProxyFields);
            }
            syncProxyFields();
            await refresh();
        },
    };
}

export function formatCacheStats({ entries, sizeBytes }) {
    if (!entries) return 'No cached documents';
    const documentLabel = entries === 1 ? 'document' : 'documents';
    return `${entries} cached ${documentLabel}, ${formatBytes(sizeBytes)}`;
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${trimDecimal(bytes / (1024 * 1024))} MB`;
    }
    return `${trimDecimal(bytes / (1024 * 1024 * 1024))} GB`;
}

function trimDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, '');
}

globalThis.MkteroPreferences = {
    init(event) {
        const document = event.target?.ownerDocument
            || event.currentTarget?.ownerDocument
            || globalThis.document;
        const cache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const controller = createPreferencesController({ document, zotero: Zotero, cache });
        return controller.init();
    },
};

if (globalThis.document?.addEventListener) {
    registerPreferencesPaneLoader({
        document: globalThis.document,
        initialize: event => globalThis.MkteroPreferences.init(event),
    });
}
