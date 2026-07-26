const PROXY_PROTOCOLS = Object.freeze({
    'http:': { type: 'http', port: 80, proxyDNS: false },
    'https:': { type: 'https', port: 443, proxyDNS: false },
    'socks5:': { type: 'socks', port: 1080, proxyDNS: false },
    'socks5h:': { type: 'socks', port: 1080, proxyDNS: true },
});
const PROXY_SERVICE_CONTRACT = '@mozilla.org/network/protocol-proxy-service;1';
let nextUserContextId = 0x4d4b0000;

export function createZoteroProxyTransport({
    zotero,
    components,
    chromeUtils,
    getConfig,
    createXMLHttpRequest = typeof XMLHttpRequest === 'function'
        ? () => new XMLHttpRequest({ mozAnon: true })
        : null,
    fallbackFetch = globalThis.fetch?.bind(globalThis),
}) {
    const proxyFactory = components?.classes?.[PROXY_SERVICE_CONTRACT];
    if (!proxyFactory || !chromeUtils?.generateQI || !createXMLHttpRequest) {
        if (!fallbackFetch) throw new Error('A fetch implementation is required');
        return {
            fetch(url, options) {
                const config = getConfig();
                if (config.enabled && !config.useSystem) throw proxyRuntimeError();
                return fallbackFetch(url, options);
            },
            dispose() {},
        };
    }
    const proxyService = components.classes[PROXY_SERVICE_CONTRACT].getService(
        components.interfaces.nsIProtocolProxyService
    );
    const cookieContext = zotero.HTTP?.newCookieContext?.() || {
        id: nextUserContextId++,
        dispose() {},
    };
    const controller = createProxyChannelController({
        protocolProxyService: proxyService,
        userContextId: cookieContext.id,
        proxyDNSFlag: components.interfaces.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
        abortCode: components.results?.NS_BINDING_ABORTED ?? 0x804b0002,
        getConfig,
        generateQI: chromeUtils.generateQI.bind(chromeUtils),
        onError: error => zotero.logError?.(error),
    });
    let disposed = false;
    return {
        fetch: createXMLHttpRequestFetch({
            createXMLHttpRequest,
            userContextId: cookieContext.id,
            getConfig,
        }),
        dispose() {
            if (disposed) return;
            disposed = true;
            controller.dispose();
            cookieContext.dispose();
        },
    };
}

export function parseProxyURL(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    }
    catch {
        throw proxyConfigurationError();
    }
    const protocol = PROXY_PROTOCOLS[url.protocol];
    if (!protocol || !url.hostname
        || (url.pathname && url.pathname !== '/')
        || url.search
        || url.hash) {
        throw proxyConfigurationError();
    }
    let username;
    let password;
    try {
        username = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
    }
    catch {
        throw proxyConfigurationError();
    }
    return {
        type: protocol.type,
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : protocol.port,
        username,
        password,
        proxyDNS: protocol.proxyDNS,
    };
}

export function shouldBypassProxy(targetURL, value) {
    const url = new URL(targetURL);
    const hostname = normalizeHostname(url.hostname);
    const port = url.port || defaultTargetPort(url.protocol);
    return String(value || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean)
        .some(entry => matchesBypassEntry(hostname, port, entry));
}

export function createProxyChannelController({
    protocolProxyService,
    userContextId,
    proxyDNSFlag,
    abortCode = 0x804b0002,
    getConfig,
    generateQI,
    onError = () => {},
}) {
    const filter = {
        applyFilter(channel, defaultProxyInfo, callback) {
            let result = defaultProxyInfo;
            let scopedRequest = false;
            try {
                const contextID = channel.loadInfo?.originAttributes?.userContextId;
                if (contextID === userContextId) {
                    scopedRequest = true;
                    const config = getConfig();
                    if (config.enabled && !config.useSystem) {
                        const targetURL = channel.URI?.spec || channel.finalURL;
                        result = shouldBypassProxy(targetURL, config.bypass)
                            ? null
                            : createProxyInfo(
                                protocolProxyService,
                                parseProxyURL(config.url),
                                proxyDNSFlag
                            );
                    }
                }
            }
            catch (error) {
                onError(error);
                if (scopedRequest) {
                    result = null;
                    try {
                        channel.cancel(abortCode);
                    }
                    catch (cancelError) {
                        onError(cancelError);
                    }
                }
            }
            callback.onProxyFilterResult(result);
        },
        QueryInterface: generateQI(['nsIProtocolProxyChannelFilter']),
    };
    protocolProxyService.registerChannelFilter(filter, 0);
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            protocolProxyService.unregisterChannelFilter(filter);
        },
    };
}

function createProxyInfo(service, proxy, proxyDNSFlag) {
    if (proxy.type !== 'socks') {
        return service.newProxyInfo(
            proxy.type,
            proxy.host,
            proxy.port,
            proxyAuthorizationHeader(proxy),
            'mktero',
            0,
            10,
            null
        );
    }
    return service.newProxyInfoWithAuth(
        proxy.type,
        proxy.host,
        proxy.port,
        proxy.username,
        proxy.password,
        null,
        'mktero',
        proxy.proxyDNS ? proxyDNSFlag : 0,
        10,
        null
    );
}

function proxyAuthorizationHeader(proxy) {
    if (!proxy.username && !proxy.password) return null;
    const bytes = new TextEncoder().encode(`${proxy.username}:${proxy.password}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
}

function createXMLHttpRequestFetch({ createXMLHttpRequest, userContextId, getConfig }) {
    return async function xmlHttpRequestFetch(url, options = {}) {
        const config = getConfig();
        if (config.enabled && !config.useSystem) parseProxyURL(config.url);
        const signal = options.signal;
        if (signal?.aborted) throw abortReason(signal);
        return new Promise((resolve, reject) => {
            const xhr = createXMLHttpRequest();
            const maxResponseBytes = positiveNumber(options.maxResponseBytes);
            let responseTooLarge = false;
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', cancel);
                callback(value);
            };
            const cancel = () => xhr.abort();
            const rejectNetworkError = () => finish(reject, networkError());
            const rejectAbort = () => finish(
                reject,
                responseTooLarge
                    ? responseSizeError(maxResponseBytes)
                    : abortReason(signal || {})
            );
            const stopOversizedResponse = event => {
                const loaded = Number(event?.loaded) || 0;
                const total = Number(event?.total) || 0;
                if (maxResponseBytes && (loaded > maxResponseBytes || total > maxResponseBytes)) {
                    responseTooLarge = true;
                    xhr.abort();
                }
            };
            signal?.addEventListener('abort', cancel, { once: true });
            xhr.onload = () => {
                const response = createFetchResponse(xhr);
                if (maxResponseBytes
                    && responseByteLength(xhr.response) > maxResponseBytes) {
                    finish(reject, responseSizeError(maxResponseBytes));
                    return;
                }
                finish(resolve, response);
            };
            xhr.onerror = rejectNetworkError;
            xhr.onabort = rejectAbort;
            xhr.onprogress = stopOversizedResponse;
            xhr.onreadystatechange = () => {
                if (xhr.readyState !== 2 || !maxResponseBytes) return;
                const contentLength = Number(xhr.getResponseHeader?.('Content-Length'));
                if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
                    responseTooLarge = true;
                    xhr.abort();
                }
            };
            try {
                xhr.mozBackgroundRequest = true;
                xhr.open(options.method || 'GET', String(url), true);
                if (typeof xhr.setOriginAttributes !== 'function') {
                    throw proxyRuntimeError();
                }
                xhr.setOriginAttributes({ userContextId });
                xhr.responseType = 'arraybuffer';
                setRequestHeaders(xhr, options.headers);
                xhr.send(options.body ?? null);
            }
            catch (error) {
                finish(reject, error);
            }
        });
    };
}

function setRequestHeaders(xhr, headers) {
    if (!headers) return;
    if (typeof headers.forEach === 'function') {
        headers.forEach((value, name) => xhr.setRequestHeader(name, value));
        return;
    }
    const entries = Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [name, value] of entries) xhr.setRequestHeader(name, value);
}

function createFetchResponse(xhr) {
    const bytes = responseArrayBuffer(xhr.response);
    return {
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText || '',
        url: xhr.responseURL || '',
        body: null,
        headers: {
            get(name) {
                return xhr.getResponseHeader?.(name) ?? null;
            },
        },
        async arrayBuffer() {
            return bytes;
        },
        async text() {
            return new TextDecoder().decode(bytes);
        },
        async json() {
            return JSON.parse(new TextDecoder().decode(bytes));
        },
    };
}

function responseArrayBuffer(value) {
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return value;
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return new ArrayBuffer(0);
}

function responseByteLength(value) {
    const length = Number(value?.byteLength);
    return Number.isFinite(length) && length > 0 ? length : 0;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function networkError() {
    return new TypeError('NetworkError when attempting to fetch resource.');
}

function responseSizeError(maxBytes) {
    const error = new Error(
        `Response exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB size limit`
    );
    error.code = 'MKTERO_RESPONSE_TOO_LARGE';
    return error;
}

function proxyRuntimeError() {
    const error = new Error('Manual proxy routing is unavailable in this Zotero runtime.');
    error.code = 'MKTERO_PROXY_RUNTIME_UNAVAILABLE';
    return error;
}

function abortReason(signal) {
    if (signal.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function matchesBypassEntry(hostname, port, entry) {
    if (entry === '*') return true;
    let ruleHost = entry;
    let rulePort = '';
    const portSeparator = entry.lastIndexOf(':');
    if (portSeparator > -1 && /^\d+$/.test(entry.slice(portSeparator + 1))) {
        ruleHost = entry.slice(0, portSeparator);
        rulePort = entry.slice(portSeparator + 1);
    }
    if (rulePort && rulePort !== port) return false;
    ruleHost = normalizeHostname(ruleHost.replace(/^\*\./, '.'));
    if (ruleHost.startsWith('.')) {
        const suffix = ruleHost.slice(1);
        return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return hostname === ruleHost;
}

function normalizeHostname(value) {
    return String(value || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function defaultTargetPort(protocol) {
    if (protocol === 'http:') return '80';
    if (protocol === 'https:') return '443';
    return '';
}

function proxyConfigurationError() {
    const error = new Error(
        'The manual proxy address must use http, https, socks5, or socks5h.'
    );
    error.code = 'MKTERO_PROXY_CONFIG_INVALID';
    return error;
}
