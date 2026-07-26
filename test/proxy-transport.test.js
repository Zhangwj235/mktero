import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createProxyChannelController,
    createZoteroProxyTransport,
    parseProxyURL,
    shouldBypassProxy,
} from '../src/platform/proxy-transport.js';

const PROXY_SERVICE_CONTRACT = '@mozilla.org/network/protocol-proxy-service;1';

test('parses supported manual proxy URLs including authentication and remote DNS', () => {
    assert.deepEqual(parseProxyURL('http://127.0.0.1:7890'), {
        type: 'http',
        host: '127.0.0.1',
        port: 7890,
        username: '',
        password: '',
        proxyDNS: false,
    });
    assert.deepEqual(parseProxyURL('https://proxy.example'), {
        type: 'https',
        host: 'proxy.example',
        port: 443,
        username: '',
        password: '',
        proxyDNS: false,
    });
    assert.deepEqual(parseProxyURL('socks5://user:p%40ss@localhost'), {
        type: 'socks',
        host: 'localhost',
        port: 1080,
        username: 'user',
        password: 'p@ss',
        proxyDNS: false,
    });
    assert.deepEqual(parseProxyURL('socks5h://user:pass@[::1]:1081'), {
        type: 'socks',
        host: '::1',
        port: 1081,
        username: 'user',
        password: 'pass',
        proxyDNS: true,
    });
});

test('rejects unsupported or non-authority proxy addresses with one safe error', () => {
    for (const value of [
        '',
        'ftp://127.0.0.1:21',
        'http://127.0.0.1:7890/path',
        'http://user:%E0@127.0.0.1:7890',
    ]) {
        assert.throws(
            () => parseProxyURL(value),
            error => error.code === 'MKTERO_PROXY_CONFIG_INVALID'
                && (!value || !error.message.includes(value))
        );
    }
});

test('adapts anonymous XHR requests to fetch responses in the mktero proxy context', async () => {
    const payload = new TextEncoder().encode('{"code":0,"data":{"ok":true}}').buffer;
    let cookieContextDisposeCalls = 0;
    let unregisterCalls = 0;
    const request = {
        headers: {},
        open(method, url) {
            this.method = method;
            this.url = url;
        },
        setOriginAttributes(attributes) {
            this.originAttributes = attributes;
        },
        setRequestHeader(name, value) {
            this.headers[name] = value;
        },
        getResponseHeader(name) {
            return name.toLowerCase() === 'content-type'
                ? 'application/json'
                : null;
        },
        send(body) {
            this.body = body;
            this.status = 200;
            this.statusText = 'OK';
            this.response = payload;
            queueMicrotask(() => this.onload());
        },
    };
    const proxyService = {
        registerChannelFilter() {},
        unregisterChannelFilter() {
            unregisterCalls++;
        },
    };
    const zotero = {
        HTTP: {
            newCookieContext: () => ({
                id: 73,
                dispose() {
                    cookieContextDisposeCalls++;
                },
            }),
            request: assert.fail,
        },
        logError: assert.fail,
    };
    const transport = createZoteroProxyTransport({
        zotero,
        components: {
            classes: {
                [PROXY_SERVICE_CONTRACT]: {
                    getService: () => proxyService,
                },
            },
            interfaces: {
                nsIProtocolProxyService: 'proxy-service-interface',
                nsIProxyInfo: { TRANSPARENT_PROXY_RESOLVES_HOST: 1 },
            },
        },
        chromeUtils: { generateQI: () => () => {} },
        createXMLHttpRequest: () => request,
        getConfig: () => ({ enabled: true, useSystem: true, url: '', bypass: '' }),
    });
    const body = new Uint8Array([1, 2, 3]);

    const response = await transport.fetch('https://mineru.net/api/v4/test', {
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body,
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(await response.json(), { code: 0, data: { ok: true } });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'https://mineru.net/api/v4/test');
    assert.deepEqual(request.originAttributes, { userContextId: 73 });
    assert.equal(request.responseType, 'arraybuffer');
    assert.equal(request.mozBackgroundRequest, true);
    assert.equal(request.headers.Authorization, 'Bearer test');
    assert.equal(request.body, body);

    transport.dispose();
    transport.dispose();
    assert.equal(cookieContextDisposeCalls, 1);
    assert.equal(unregisterCalls, 1);
});

test('rejects an invalid manual proxy before starting a network request', async () => {
    const proxyService = {
        registerChannelFilter() {},
        unregisterChannelFilter() {},
    };
    const transport = createZoteroProxyTransport({
        zotero: {
            HTTP: {
                newCookieContext: () => ({ id: 8, dispose() {} }),
                request: assert.fail,
            },
        },
        components: {
            classes: {
                [PROXY_SERVICE_CONTRACT]: { getService: () => proxyService },
            },
            interfaces: {
                nsIProtocolProxyService: 'proxy-service-interface',
                nsIProxyInfo: { TRANSPARENT_PROXY_RESOLVES_HOST: 1 },
            },
        },
        chromeUtils: { generateQI: () => () => {} },
        createXMLHttpRequest: assert.fail,
        getConfig: () => ({
            enabled: true,
            useSystem: false,
            url: 'ftp://127.0.0.1:21',
            bypass: '',
        }),
    });

    await assert.rejects(
        transport.fetch('https://mineru.net/api/v4/test'),
        error => error.code === 'MKTERO_PROXY_CONFIG_INVALID'
    );
});

test('aborts an oversized XHR response before it is fully buffered', async () => {
    const request = {
        open() {},
        setOriginAttributes() {},
        setRequestHeader() {},
        getResponseHeader(name) {
            return name.toLowerCase() === 'content-length' ? '257' : null;
        },
        send() {
            this.readyState = 2;
            this.onreadystatechange();
        },
        abort() {
            this.aborted = true;
            queueMicrotask(() => this.onabort());
        },
    };
    const proxyService = {
        registerChannelFilter() {},
        unregisterChannelFilter() {},
    };
    const transport = createZoteroProxyTransport({
        zotero: {
            HTTP: { newCookieContext: () => ({ id: 9, dispose() {} }) },
        },
        components: {
            classes: {
                [PROXY_SERVICE_CONTRACT]: { getService: () => proxyService },
            },
            interfaces: {
                nsIProtocolProxyService: 'proxy-service-interface',
                nsIProxyInfo: { TRANSPARENT_PROXY_RESOLVES_HOST: 1 },
            },
        },
        chromeUtils: { generateQI: () => () => {} },
        createXMLHttpRequest: () => request,
        getConfig: () => ({ enabled: true, useSystem: true, url: '', bypass: '' }),
    });

    await assert.rejects(
        transport.fetch('https://download.example/result.zip', {
            maxResponseBytes: 256,
        }),
        error => error.code === 'MKTERO_RESPONSE_TOO_LARGE'
    );
    assert.equal(request.aborted, true);
});

test('routes only the mktero request context through the configured manual proxy', () => {
    let registeredFilter;
    const createdProxy = { kind: 'manual-proxy' };
    const proxyService = {
        registerChannelFilter(filter, position) {
            registeredFilter = filter;
            assert.equal(position, 0);
        },
        newProxyInfoWithAuth(...args) {
            assert.deepEqual(args, [
                'socks', '127.0.0.1', 1080, 'reader', 'secret',
                null, 'mktero', 1, 10, null,
            ]);
            return createdProxy;
        },
        unregisterChannelFilter: assert.fail,
    };
    const controller = createProxyChannelController({
        protocolProxyService: proxyService,
        userContextId: 42,
        proxyDNSFlag: 1,
        getConfig: () => ({
            enabled: true,
            useSystem: false,
            url: 'socks5h://reader:secret@127.0.0.1:1080',
            bypass: '',
        }),
        generateQI: () => 'query-interface',
    });
    const defaultProxy = { kind: 'system-proxy' };
    let result;

    registeredFilter.applyFilter({
        URI: { spec: 'https://mineru.net/api/v4/file-urls/batch' },
        loadInfo: { originAttributes: { userContextId: 42 } },
    }, defaultProxy, {
        onProxyFilterResult(value) {
            result = value;
        },
    });

    assert.equal(result, createdProxy);
    assert.equal(registeredFilter.QueryInterface, 'query-interface');
    assert.equal(typeof controller.dispose, 'function');
});

test('sends HTTP proxy credentials through the Proxy-Authorization header', () => {
    let registeredFilter;
    const createdProxy = { kind: 'authenticated-http-proxy' };
    const proxyService = {
        registerChannelFilter(filter) {
            registeredFilter = filter;
        },
        newProxyInfo(...args) {
            assert.deepEqual(args, [
                'http', 'proxy.example', 7890, 'Basic dXNlcjpwQHNz',
                'mktero', 0, 10, null,
            ]);
            return createdProxy;
        },
        newProxyInfoWithAuth: assert.fail,
        unregisterChannelFilter() {},
    };
    createProxyChannelController({
        protocolProxyService: proxyService,
        userContextId: 42,
        proxyDNSFlag: 1,
        getConfig: () => ({
            enabled: true,
            useSystem: false,
            url: 'http://user:p%40ss@proxy.example:7890',
            bypass: '',
        }),
        generateQI: () => () => {},
    });
    let result;

    registeredFilter.applyFilter({
        URI: { spec: 'https://mineru.net/api/v4/test' },
        loadInfo: { originAttributes: { userContextId: 42 } },
    }, null, {
        onProxyFilterResult(value) {
            result = value;
        },
    });

    assert.equal(result, createdProxy);
});

test('keeps system proxy resolution and turns bypass matches into direct connections', () => {
    let registeredFilter;
    let unregisteredFilter;
    let config = { enabled: true, useSystem: true, url: '', bypass: '' };
    const proxyService = {
        registerChannelFilter(filter) {
            registeredFilter = filter;
        },
        newProxyInfoWithAuth: assert.fail,
        unregisterChannelFilter(filter) {
            unregisteredFilter = filter;
        },
    };
    const controller = createProxyChannelController({
        protocolProxyService: proxyService,
        userContextId: 42,
        proxyDNSFlag: 1,
        getConfig: () => config,
        generateQI: () => () => {},
    });
    const defaultProxy = { kind: 'system-proxy' };
    const route = (url, userContextId = 42) => {
        let result;
        registeredFilter.applyFilter({
            URI: { spec: url },
            loadInfo: { originAttributes: { userContextId } },
        }, defaultProxy, {
            onProxyFilterResult(value) {
                result = value;
            },
        });
        return result;
    };

    assert.equal(route('https://mineru.net/api/v4/test'), defaultProxy);
    config = {
        enabled: true,
        useSystem: false,
        url: 'http://127.0.0.1:7890',
        bypass: '*.openxlab.org.cn',
    };
    assert.equal(route('https://cdn-mineru.openxlab.org.cn/result.zip'), null);
    assert.equal(route('https://mineru.net/api/v4/test', 7), defaultProxy);

    controller.dispose();
    assert.equal(unregisteredFilter, registeredFilter);
});

test('cancels a mktero channel instead of falling back when manual proxy setup fails', () => {
    let registeredFilter;
    let cancelledWith;
    let result = 'unset';
    const errors = [];
    const proxyService = {
        registerChannelFilter(filter) {
            registeredFilter = filter;
        },
        unregisterChannelFilter() {},
    };
    createProxyChannelController({
        protocolProxyService: proxyService,
        userContextId: 42,
        proxyDNSFlag: 1,
        abortCode: 99,
        getConfig: () => ({
            enabled: true,
            useSystem: false,
            url: 'ftp://127.0.0.1:21',
            bypass: '',
        }),
        generateQI: () => () => {},
        onError: error => errors.push(error),
    });

    registeredFilter.applyFilter({
        URI: { spec: 'https://mineru.net/api/v4/test' },
        loadInfo: { originAttributes: { userContextId: 42 } },
        cancel(code) {
            cancelledWith = code;
        },
    }, { kind: 'system-proxy' }, {
        onProxyFilterResult(value) {
            result = value;
        },
    });

    assert.equal(cancelledWith, 99);
    assert.equal(result, null);
    assert.equal(errors[0].code, 'MKTERO_PROXY_CONFIG_INVALID');
});

test('matches comma-separated no-proxy hosts without leaking to sibling domains', () => {
    const bypass = 'localhost, 127.0.0.1, *.local, .internal.example, api.example:8443';

    assert.equal(shouldBypassProxy('http://localhost/status', bypass), true);
    assert.equal(shouldBypassProxy('http://127.0.0.1/status', bypass), true);
    assert.equal(shouldBypassProxy('https://worker.local/job', bypass), true);
    assert.equal(shouldBypassProxy('https://internal.example/job', bypass), true);
    assert.equal(shouldBypassProxy('https://a.internal.example/job', bypass), true);
    assert.equal(shouldBypassProxy('https://api.example:8443/job', bypass), true);
    assert.equal(shouldBypassProxy('https://api.example/job', bypass), false);
    assert.equal(shouldBypassProxy('https://notinternal.example/job', bypass), false);
});
