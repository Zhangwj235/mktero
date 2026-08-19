import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MarkdownTranslationService,
    TRANSLATION_PROMPT_VERSION,
} from '../src/ai/markdown-translation-service.js';

const SETTINGS = Object.freeze({
    enabled: true,
    provider: 'custom',
    protocol: 'openai-chat-completions',
    apiBase: 'https://api.example.com/v1',
    apiKey: 'token',
    model: 'example-chat',
    targetLanguage: 'zh-CN',
    requestTimeoutMs: 30_000,
    maxOutputTokens: 2_048,
});

test('tests a valid connection before AI translation is enabled', async () => {
    let request;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(value) {
                request = value;
                return { text: 'OK', model: 'example-chat' };
            },
        },
        getSettings: () => ({
            ...SETTINGS,
            enabled: false,
            reasoning: 'xhigh',
        }),
    });

    const result = await service.testConnection();

    assert.equal(result.text, 'OK');
    assert.equal(request.settings.enabled, true);
    assert.equal(request.settings.reasoning, 'none');
    assert.equal(request.maxOutputTokens, 4);
    assert.equal(request.acceptNonTextResponse, true);
    assert.deepEqual(request.messages, [{
        role: 'user',
        content: 'hi',
    }]);
});

test('translates a complete Markdown document in one provider request', async () => {
    const requests = [];
    const progress = [];
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const requestMarkdown = request.messages[1].content;
                requests.push(requestMarkdown);
                return {
                    text: translateBatchRequest(requestMarkdown, source => (
                        source
                            .replace('# Paper', '# 论文')
                            .replace('Original paragraph.', '译文段落。')
                    )),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nOriginal paragraph.\n\n```js\ncode();\n```',
        onProgress: value => progress.push(value),
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(parseTranslationRequest(requests[0]).map(entry => (
        entry.sourceMarkdown
    )), ['# Paper', 'Original paragraph.']);
    assert.doesNotMatch(requests[0], /code\(\)/);
    assert.equal(
        result.translatedMarkdown,
        '# 论文\n\n译文段落。\n\n```js\ncode();\n```'
    );
    assert.match(result.comparisonMarkdown, /# Paper\n\n# 论文/);
    assert.equal(result.totalBlocks, 2);
    assert.equal(result.completedBlocks, 2);
    assert.deepEqual(result.blockRanges.map(range => range.id), [
        'translation-0-0-7-heading',
        'translation-1-9-28-paragraph',
        'translation-2-30-47-structural',
    ]);
    assert.equal(result.cacheHit, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 0,
        total: 2,
    });
    assert.deepEqual(progress.at(-1), {
        stage: 'complete',
        completed: 2,
        total: 2,
    });
    assert.equal(cached.length, 1);
    assert.equal(cached[0][0], 'a'.repeat(64));
    assert.equal(cached[0][1], 'c'.repeat(64));
    assert.equal(cached[0][2].translatedMarkdown, result.translatedMarkdown);
});

test('streams the complete document by default and uses the selected language', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# Article traduit'
                    ),
                    model: 'stream-model',
                };
            },
            generateText: assert.fail,
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: true,
            targetLanguage: 'fr-FR',
        }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /French/);
    assert.equal(result.translatedMarkdown, '# Article traduit');
});

test('translates an explicitly selected language without changing the default', async () => {
    const requests = [];
    const cacheInputs = [];
    const settings = {
        ...SETTINGS,
        streaming: false,
        targetLanguage: 'zh-CN',
    };
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 한국어 논문'
                    ),
                };
            },
        },
        getSettings: () => settings,
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'c'.repeat(64);
        },
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'ko-KR',
    });

    assert.match(requests[0].messages[0].content, /Korean/);
    assert.equal(cacheInputs[0].targetLanguage, 'ko-KR');
    assert.equal(result.targetLanguage, 'ko-KR');
    assert.equal(settings.targetLanguage, 'zh-CN');
});

test('rejects English as a translation target before calling the provider', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'en-US',
    }), error => error?.code === 'AI_INVALID_REQUEST');
});

test('reports provider stages before validating the complete translation', async () => {
    const progress = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                request.onStreamEvent({ type: 'reasoning-start' });
                request.onStreamEvent({ type: 'reasoning-delta' });
                request.onStreamEvent({ type: 'text-start' });
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# Article traduit'
                    ),
                    model: 'stream-model',
                };
            },
            generateText: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: true }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(progress.map(value => value.stage), [
        'preparing',
        'requesting',
        'reasoning',
        'translating',
        'validating',
        'complete',
    ]);
});

test('isolates document translations by reasoning and source content', async () => {
    const cacheInputs = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
            reasoning: 'high',
        }),
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'c'.repeat(64);
        },
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cacheInputs[0].source, '# Paper');
    assert.equal(cacheInputs[0].reasoning, 'high');
});

test('keeps a completed document translation when caching fails', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => { throw new Error('disk full'); },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result.translatedMarkdown, '# 论文');
    assert.equal(result.cacheStatus, 'missing');
    assert.deepEqual(cacheErrors, ['disk full']);
});

test('continues translating without persistence when cache hashing fails', async () => {
    const cacheErrors = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 论文'
                    ),
                };
            },
        },
        cache: {
            getTranslation: assert.fail,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => { throw new Error('hash unavailable'); },
        onCacheError: error => cacheErrors.push(error.message),
    });

    const cached = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });
    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cached, null);
    assert.equal(result.translatedMarkdown, '# 论文');
    assert.equal(result.translationKey, null);
    assert.equal(result.cacheStatus, 'missing');
    assert.equal(providerCalls, 1);
    assert.deepEqual(cacheErrors, ['hash unavailable', 'hash unavailable']);
});

test('lists complete and partial cached translations for every language', async () => {
    const blockID = 'translation-0-0-7-heading';
    const cachedByLanguage = new Map([
        ['zh-CN', {
            translatedMarkdown: '# \u8bba\u6587',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# \u8bba\u6587' }],
            model: 'cached-model',
            targetLanguage: 'zh-CN',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['ja-JP', {
            translatedMarkdown: '# \u8ad6\u6587',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# \u8ad6\u6587' }],
            model: 'cached-model',
            targetLanguage: 'ja-JP',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['fr-FR', {
            translatedMarkdown: '# Paper',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# Paper' }],
            model: 'cached-model',
            targetLanguage: 'fr-FR',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: true,
            failedBlocks: [],
        }],
        ['en-US', {
            translatedMarkdown: '# Paper',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# Paper' }],
            model: 'cached-model',
            targetLanguage: 'en-US',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['es-ES', {
            translatedMarkdown: '# Articulo',
            comparisonMarkdown: '',
            blocks: [{ id: 'unknown-block', markdown: '# Articulo' }],
            model: 'cached-model',
            targetLanguage: 'es-ES',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
    ]);
    const providerCalls = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls.push(request);
                throw new Error('The provider must not be called');
            },
        },
        cache: {
            getTranslation: async (_documentKey, language) => (
                cachedByLanguage.get(language) || null
            ),
        },
        getSettings: () => ({ ...SETTINGS, targetLanguage: 'zh-CN' }),
        createCacheKey: async value => JSON.parse(value).targetLanguage,
    });

    const japanese = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'ja-JP',
    });
    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(japanese.targetLanguage, 'ja-JP');
    assert.equal(japanese.translatedMarkdown, '# \u8ad6\u6587');
    assert.deepEqual(variants.map(result => [
        result.targetLanguage,
        result.partial,
    ]), [
        ['zh-CN', false],
        ['ja-JP', false],
        ['fr-FR', true],
    ]);
    assert.equal(cachedByLanguage.has('en-US'), true);
    assert.equal(variants.some(result => (
        result.targetLanguage === 'en-US'
    )), false);
    assert.equal(providerCalls.length, 0);
});

test('continues translating when reading the Markdown translation cache fails', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => { throw new Error('cache unreadable'); },
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result.translatedMarkdown, '# 论文');
    assert.deepEqual(cacheErrors, ['cache unreadable']);
});

test('always stores completed translations with the Markdown cache entry', async () => {
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({
            ...SETTINGS,
            cacheEnabled: false,
            streaming: false,
        }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cached.length, 1);
});

for (const [name, output] of [
    ['raw HTML', '<script>alert(1)</script>'],
    ['a Markdown image', '![Injected](https://example.com/tracker.png)'],
]) {
    test(`keeps source text when the AI provider returns ${name}`, async () => {
        const service = createBoundaryService({ output });

        const result = await service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: 'Translate this paragraph.',
        });

        assert.equal(result.translatedMarkdown, 'Translate this paragraph.');
        assert.equal(result.partial, true);
        assert.equal(result.completedBlocks, 0);
        assert.equal(result.failedBlocks.length, 1);
    });
}

test('accepts a Markdown paragraph over the removed 64 KB block limit', async () => {
    let providerCalls = 0;
    const source = `Paragraph ${'x'.repeat(64 * 1024)}.`;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(result.translatedMarkdown, '译文。');
    assert.equal(providerCalls, 1);
});

test('counts protected content toward the 4 MB document input limit', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: `Translate \`${'x'.repeat(4 * 1024 * 1024)}\`.`,
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('rejects more than 2,000 translatable blocks before calling the provider', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: Array.from(
            { length: 2_001 },
            (_, index) => `Paragraph ${index}.`
        ).join('\n\n'),
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('rejects cumulative translation input over 4 MB before calling the provider', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });
    const paragraph = `Paragraph ${'x'.repeat(60 * 1024)}.`;

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: Array.from({ length: 69 }, () => paragraph).join('\n\n'),
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('accepts a translated document over the removed 256 KB block limit', async () => {
    const output = `译文${'x'.repeat(256 * 1024)}`;
    const service = createBoundaryService({
        output,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Translate this paragraph.',
    });

    assert.equal(result.translatedMarkdown, output);
});

test('rejects a document translation over 4 MB without caching it', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: `译${'x'.repeat(4 * 1024 * 1024)}`,
        onProviderCall: () => { providerCalls++; },
    });
    service.cache.putTranslation = assert.fail;

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Translate this paragraph.',
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
    assert.equal(providerCalls, 1);
});

test('counts restored protected content toward the document output limit', async () => {
    const protectedContent = 'x'.repeat(4 * 1024 * 1024 - 1_024);
    const source = `Translate \`${protectedContent}\`.`;
    let requestMarkdown;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requestMarkdown = request.messages[1].content;
                const placeholder = parseTranslationRequest(requestMarkdown)[0]
                    .sourceMarkdown.match(
                    /MKTEROPROTECTED\d+PLACEHOLDER/
                )?.[0];
                return {
                    text: translateSingleBlockRequest(
                        requestMarkdown,
                        `${'译'.repeat(1_024)} ${placeholder}`
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
    assert.match(requestMarkdown, /MKTEROPROTECTED\d+PLACEHOLDER/);
});

test('cancels active batches when completed translations exceed 4 MB', async () => {
    let calls = 0;
    let aborted = 0;
    const oversizedParagraph = `译文${'x'.repeat(1_100_000)}`;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                const heading = entries.find(entry => (
                    entry.sourceMarkdown.startsWith('# ')
                ));
                if (heading?.sourceMarkdown === '# Section 4') {
                    await new Promise((resolve, reject) => {
                        request.signal.addEventListener('abort', () => {
                            aborted++;
                            reject(Object.assign(new Error('aborted'), {
                                name: 'AbortError',
                            }));
                        }, { once: true });
                    });
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry === heading
                            ? entry.sourceMarkdown
                            : oversizedParagraph,
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });
    const source = Array.from({ length: 5 }, (_, index) => (
        `# Section ${index}\n\nParagraph ${index}.`
    )).join('\n\n');

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');

    assert.equal(calls, 5);
    assert.equal(aborted, 1);
});

test('loads a complete document translation without calling the provider', async () => {
    const cached = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0-0-7-heading', markdown: '# 论文' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => cached,
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.deepEqual(result, {
        ...cached,
        comparisonMarkdown: '# Paper\n\n# 论文',
        comparisonSourceRanges: [{
            sourceFrom: 0,
            sourceTo: 7,
            comparisonFrom: 0,
        }],
        comparisonTranslationRanges: [{ from: 9, to: 13 }],
        blockRanges: [{
            id: 'translation-0-0-7-heading',
            type: 'heading',
            sourceFrom: 0,
            sourceTo: 7,
            translatedFrom: 0,
            translatedTo: 4,
            comparisonSourceFrom: 0,
            comparisonSourceTo: 7,
            comparisonTranslationFrom: 9,
            comparisonTranslationTo: 13,
        }],
        translationKey: 'c'.repeat(64),
        cacheHit: true,
        cacheStatus: 'complete',
        totalBlocks: 1,
        completedBlocks: 1,
    });
});

test('rejects caches from the previous reference protection protocol', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => ({
                translatedMarkdown: '# 论文',
                comparisonMarkdown: '# Paper\n\n# 论文',
                blocks: [{
                    id: 'translation-0-0-7-heading',
                    markdown: '# 论文',
                }],
                model: 'cached-model',
                targetLanguage: 'zh-CN',
                promptVersion: 'mktero-translation-v6',
                partial: false,
                failedBlocks: [],
            }),
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result, null);
    assert.deepEqual(cacheErrors, [
        'The cached document translation identity changed',
    ]);
});

test('reuses a complete cache when the visible translation uses another language', async () => {
    const cached = {
        translatedMarkdown: '# Article français',
        comparisonMarkdown: '# Paper\n\n# Article français',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# Article français',
        }],
        model: 'cached-model',
        targetLanguage: 'fr-FR',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => cached,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, targetLanguage: 'fr-FR' }),
        createCacheKey: async () => 'd'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# \u8bba\u6587',
            }],
            failedBlocks: [],
            targetLanguage: 'zh-CN',
        },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translatedMarkdown, '# Article français');
});

test('reports cached partial translations but retries them on explicit translation', async () => {
    const blockID = 'translation-0-0-7-heading';
    const cached = {
        translatedMarkdown: '# Paper',
        comparisonMarkdown: '# Paper\n\n> # Paper',
        blocks: [{ id: blockID, markdown: '# Paper' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{ id: blockID, message: 'Invalid response' }],
    };
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 论文'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const restored = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });
    const retried = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(restored.partial, true);
    assert.equal(restored.completedBlocks, 0);
    assert.equal(retried.partial, false);
    assert.equal(retried.translatedMarkdown, '# 论文');
    assert.equal(providerCalls, 1);
});

test('resumes a selected partial language while another language is visible', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cachedFrench = {
        translatedMarkdown: '# Article\n\nParagraph.',
        comparisonMarkdown: '',
        blocks: [{
            id: headingID,
            markdown: '# Article',
        }, {
            id: paragraphID,
            markdown: 'Paragraph.',
        }],
        model: 'cached-model',
        targetLanguage: 'fr-FR',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{
            id: paragraphID,
            message: 'Invalid response',
        }],
    };
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        'Paragraphe.'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async (_documentKey, translationKey) => (
                translationKey === 'f'.repeat(64) ? cachedFrench : null
            ),
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async value => (
            JSON.parse(value).targetLanguage === 'fr-FR'
                ? 'f'.repeat(64)
                : 'j'.repeat(64)
        ),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        targetLanguage: 'fr-FR',
        existingTranslation: {
            translationKey: 'j'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8ad6\u6587' }],
            failedBlocks: [],
            targetLanguage: 'ja-JP',
        },
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /French/);
    assert.deepEqual(
        parseTranslationRequest(requests[0].messages[1].content),
        [{ id: paragraphID, sourceMarkdown: 'Paragraph.' }]
    );
    assert.equal(result.partial, false);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translatedMarkdown, '# Article\n\nParagraphe.');
});

test('treats a cached translation with a missing block as partial and repairs it', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cached = {
        translatedMarkdown: '# \u8bba\u6587\n\nParagraph.',
        comparisonMarkdown: '',
        blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: paragraphID,
                        translatedMarkdown: '\u6bb5\u843d\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const restored = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown,
    });
    const repaired = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });

    assert.equal(restored.partial, true);
    assert.deepEqual(restored.failedBlocks, [{
        id: paragraphID,
        message: 'Cached translation is incomplete',
    }]);
    assert.deepEqual(requests, [[{
        id: paragraphID,
        sourceMarkdown: 'Paragraph.',
    }]]);
    assert.equal(repaired.partial, false);
    assert.equal(repaired.translatedMarkdown, '# \u8bba\u6587\n\n\u6bb5\u843d\u3002');
});

test('retries only failed cached blocks and preserves successful translations', async () => {
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cached = {
        translatedMarkdown: '# 论文\n\nParagraph.',
        comparisonMarkdown: [
            '# Paper',
            '',
            '> # 论文',
            '',
            'Paragraph.',
            '',
            '> Paragraph.',
        ].join('\n'),
        blocks: [{
            id: headingID,
            markdown: '# 论文',
        }, {
            id: paragraphID,
            markdown: 'Paragraph.',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{ id: paragraphID, message: 'Invalid response' }],
    };
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '译文。',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], [{
        id: paragraphID,
        sourceMarkdown: 'Paragraph.',
    }]);
    assert.equal(result.translatedMarkdown, '# 论文\n\n译文。');
    assert.deepEqual(result.blocks, [{
        id: headingID,
        markdown: '# 论文',
    }, {
        id: paragraphID,
        markdown: '译文。',
    }]);
    assert.equal(result.partial, false);
    assert.equal(result.completedBlocks, 2);
    assert.equal(writes[0][2].partial, false);
});

test('retries one failed block from the visible result without a cache read', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '\u7b2c\u4e00\u6bb5\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: 'First paragraph.',
            }, {
                id: secondID,
                markdown: 'Second paragraph.',
            }],
            failedBlocks: [{ id: firstID, message: 'Invalid response' }, {
                id: secondID,
                message: 'Timed out',
            }],
            targetLanguage: 'zh-CN',
        },
    });

    assert.deepEqual(requests, [[{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]]);
    assert.equal(
        result.translatedMarkdown,
        '# \u8bba\u6587\n\n\u7b2c\u4e00\u6bb5\u3002\n\nSecond paragraph.'
    );
    assert.deepEqual(result.failedBlocks, [{
        id: secondID,
        message: 'Timed out',
    }]);
    assert.equal(result.completedBlocks, 2);
    assert.equal(result.partial, true);
});

test('retranslates one successful block and preserves the other visible translations', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const progress = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: firstID,
                        translatedMarkdown: '\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: '\u7b2c\u4e00\u6bb5\u3002',
            }, {
                id: secondID,
                markdown: '\u7b2c\u4e8c\u6bb5\u3002',
            }],
            failedBlocks: [],
            targetLanguage: 'zh-CN',
        },
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(requests, [[{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]]);
    assert.equal(
        result.translatedMarkdown,
        '# \u8bba\u6587\n\n\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002\n\n\u7b2c\u4e8c\u6bb5\u3002'
    );
    assert.equal(result.partial, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 2,
        total: 3,
    });
    assert.ok(progress.every(value => (
        value.completed === undefined || value.completed <= value.total
    )));
});

test('retranslates one successful block when cache hashing is unavailable', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                const secondRequest = requests.length === 2;
                const translated = new Map([
                    [headingID, '# \u8bba\u6587'],
                    [firstID, secondRequest
                        ? '\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002'
                        : '\u7b2c\u4e00\u6bb5\u3002'],
                    [secondID, '\u7b2c\u4e8c\u6bb5\u3002'],
                ]);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: translated.get(entry.id),
                    }))),
                };
            },
        },
        cache: {
            getTranslation: assert.fail,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const first = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });
    const second = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: first,
    });

    assert.deepEqual(requests[1], [{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]);
    assert.equal(
        second.translatedMarkdown,
        '# \u8bba\u6587\n\n\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002\n\n\u7b2c\u4e8c\u6bb5\u3002'
    );
    assert.equal(second.translationKey, null);
});

test('forces a fresh full translation instead of returning a complete cache hit', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const requests = [];
    const progress = [];
    const cached = {
        translatedMarkdown: '# \u8bba\u6587\n\n\u6bb5\u843d\u3002',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# \u8bba\u6587',
        }, {
            id: 'translation-1-9-19-paragraph',
            markdown: '\u6bb5\u843d\u3002',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.id.includes('heading')
                            ? '# \u65b0\u8bba\u6587'
                            : '\u65b0\u6bb5\u843d\u3002',
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        forceRetranslate: true,
        existingTranslation: {
            ...cached,
            translationKey: 'c'.repeat(64),
        },
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(requests.flat().map(entry => entry.id), [
        'translation-0-0-7-heading',
        'translation-1-9-19-paragraph',
    ]);
    assert.equal(result.translatedMarkdown, '# \u65b0\u8bba\u6587\n\n\u65b0\u6bb5\u843d\u3002');
    assert.equal(result.cacheHit, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 0,
        total: 2,
    });
});

test('does not replace a complete cache with a partial retranslation', async () => {
    const cached = {
        translatedMarkdown: '# \u8bba\u6587',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# \u8bba\u6587',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const writes = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '<script>invalid</script>'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        forceRetranslate: true,
        existingTranslation: {
            ...cached,
            translationKey: 'c'.repeat(64),
        },
    });

    assert.equal(providerCalls, 3);
    assert.equal(result.partial, true);
    assert.equal(result.cacheStatus, 'complete');
    assert.deepEqual(writes, []);
});

test('retranslates every block when a visible retry uses changed settings', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                const translations = new Map([
                    [headingID, '# Article français'],
                    [firstID, 'Premier paragraphe.'],
                    [secondID, 'Deuxième paragraphe.'],
                ]);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: translations.get(entry.id),
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
            targetLanguage: 'fr-FR',
        }),
        createCacheKey: async () => 'd'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: 'First paragraph.',
            }, {
                id: secondID,
                markdown: '\u7b2c\u4e8c\u6bb5\u3002',
            }],
            failedBlocks: [{ id: firstID, message: 'Invalid response' }],
            targetLanguage: 'zh-CN',
        },
    });

    assert.deepEqual(requests.flat().map(entry => entry.id), [
        headingID,
        firstID,
        secondID,
    ]);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translationKey, 'd'.repeat(64));
    assert.equal(result.partial, false);
    assert.doesNotMatch(result.translatedMarkdown, /\u8bba\u6587|\u7b2c\u4e8c\u6bb5/);
    assert.equal(writes[0][1], 'd'.repeat(64));
    assert.equal(writes[0][2].targetLanguage, 'fr-FR');
});

test('keeps source blocks and caches a structurally incomplete partial response', async () => {
    let calls = 0;
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                return { text: '# 论文' };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(result.translatedMarkdown, '# Paper\n\nParagraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.failedBlocks.length, 2);
    assert.equal(calls, 5);
    assert.equal(cached.length, 1);
    assert.equal(cached[0][2].partial, true);
    assert.deepEqual(cached[0][2].failedBlocks, result.failedBlocks);
});

test('keeps source blocks when a document response reaches the output limit', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                return {
                    text: '部分译文',
                    finishReason: 'length',
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(result.translatedMarkdown, 'One paragraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
});

test('keeps source blocks when a streamed response reaches the output limit', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: assert.fail,
            async streamText() {
                return {
                    text: '部分译文',
                    finishReason: 'length',
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: true }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(result.translatedMarkdown, 'One paragraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
});

test('stops a complete document translation when canceled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                controller.abort();
                return { text: '# 论文' };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
        signal: controller.signal,
    }), error => error?.name === 'AbortError');
    assert.equal(calls, 1);
});

test('translates H1 sections with at most five concurrent requests and restores source order', async () => {
    let active = 0;
    let maximumActive = 0;
    const requests = [];
    const gates = new Map();
    const requestWaiters = [];
    const notifyRequest = () => {
        for (let index = requestWaiters.length - 1; index >= 0; index--) {
            if (requests.length < requestWaiters[index].count) continue;
            requestWaiters[index].resolve();
            requestWaiters.splice(index, 1);
        }
    };
    const waitForRequestCount = count => requests.length >= count
        ? Promise.resolve()
        : new Promise(resolve => requestWaiters.push({ count, resolve }));
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                active++;
                maximumActive = Math.max(maximumActive, active);
                const requestMarkdown = request.messages[1].content;
                const title = parseTranslationRequest(requestMarkdown)
                    .find(entry => entry.sourceMarkdown.startsWith('# '))
                    ?.sourceMarkdown || '';
                const index = Number(title.match(/Section (\d+)/)?.[1] || 0);
                requests.push({ index, requestMarkdown });
                notifyRequest();
                const gate = deferred();
                gates.set(index, gate);
                await gate.promise;
                active--;
                return {
                    text: translateMarkedSection(requestMarkdown, `# 翻译 ${index}`),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = Array.from({ length: 7 }, (_, index) => [
        `# Section ${index}`,
        '',
        `Paragraph ${index}.`,
    ].join('\n')).join('\n\n');

    const result = service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    await waitForRequestCount(5);
    gates.get(4).resolve();
    await waitForRequestCount(6);
    gates.get(5).resolve();
    await waitForRequestCount(7);
    gates.get(6).resolve();
    for (const index of [3, 2, 1, 0]) gates.get(index).resolve();

    const completed = await result;

    assert.equal(requests.length, 7);
    assert.equal(maximumActive, 5);
    assert.deepEqual(
        [...completed.translatedMarkdown.matchAll(/^# 翻译 (\d+)$/gm)]
            .map(match => Number(match[1])),
        [0, 1, 2, 3, 4, 5, 6]
    );
    assert.equal(completed.usage.totalTokens, 70);
});

test('splits a long H1 section into bounded batches and restores paragraph order', async () => {
    const requests = [];
    let active = 0;
    let maximumActive = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                active++;
                maximumActive = Math.max(maximumActive, active);
                requests.push(request.messages[1].content);
                await Promise.resolve();
                active--;
                return {
                    text: translateBatchRequest(
                        request.messages[1].content,
                        sourceMarkdown => sourceMarkdown
                            .replace('# One section', '# 一个章节')
                            .replace(/Paragraph (\d+)\./g, '译文段落 $1。')
                    ),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = [
        '# One section',
        ...Array.from({ length: 17 }, (_, index) => [
            '',
            `Paragraph ${index}.`,
        ]).flat(),
    ].join('\n');

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(requests.length, 3);
    assert.ok(maximumActive <= 5);
    assert.deepEqual(
        requests.map(request => parseTranslationRequest(request).length),
        [8, 8, 2]
    );
    assert.deepEqual(
        [...result.translatedMarkdown.matchAll(/^译文段落 (\d+)。$/gm)]
            .map(match => Number(match[1])),
        Array.from({ length: 17 }, (_, index) => index)
    );
    assert.equal(result.usage.totalTokens, 30);
});

test('retries only a missing block from an otherwise valid batch', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                if (requests.length === 1) {
                    return {
                        text: JSON.stringify([{
                            id: entries[0].id,
                            translatedMarkdown: '# 论文',
                        }]),
                    };
                }
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '译文。',
                    }]),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.deepEqual(requests.map(entries => entries.length), [2, 1]);
    assert.equal(requests[1][0].sourceMarkdown, 'Paragraph.');
    assert.equal(result.translatedMarkdown, '# 论文\n\n译文。');
});

test('falls back to translating only text segments after protected content retries fail', async () => {
    const paragraph = [
        'As analyzed in Sec. S5, the proposed NARI and NARF are induced jointly',
        'by the structures of model and human neural representations. We visualize',
        'such structures (the Gram matrices $X_{c}^{\\top}X_{c}$ and',
        '$Y_{c}Y_{c}^{\\top}$ of centered data as described in Sec. S5) for',
        'different models and human subjects in Fig. S3, considering 34 transitive',
        'reasoning problems. Results show that the structures vary among different',
        'models, layers of the same models, and different human subjects. Therefore,',
        'the joint effect of them in NARI/NARF would be sample-specific, motivating',
        'our multi-subject integration approach to capture robust improvement signals.',
    ].join(' ');
    const figure = '![Figure S3. Neural structures.](images/s3.png)';
    const markdown = `${paragraph}\n\n${figure}`;
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                if ('sourceText' in entries[0]) {
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedText: `译${entry.id}`,
                        }))),
                    };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.includes(
                            'Gram matrices'
                        )
                            ? entry.sourceMarkdown.replace(
                                /MKTEROPROTECTED\d+PLACEHOLDER/,
                                ''
                            )
                            : entry.sourceMarkdown,
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });

    assert.equal(requests.length, 4);
    assert.equal(requests[0].length, 2);
    assert.deepEqual(requests.slice(1, 3).map(entries => entries.length), [1, 1]);
    assert.ok(requests[3].every(entry => 'sourceText' in entry));
    assert.doesNotMatch(
        JSON.stringify(requests[3]),
        /MKTEROPROTECTED|X_\{c\}|Y_\{c\}|Fig\. S3/
    );
    assert.equal(result.partial, false);
    assert.deepEqual(result.failedBlocks, []);
    assert.equal(result.translatedMarkdown.match(/\$X_\{c\}/g)?.length, 1);
    assert.equal(result.translatedMarkdown.match(/\$Y_\{c\}/g)?.length, 1);
    assert.equal(result.translatedMarkdown.match(/Fig\. S3/g)?.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][2].partial, false);
    assert.deepEqual(writes[0][2].failedBlocks, []);
});

for (const { name, fallbackResponse, messagePattern } of [{
    name: 'missing',
    fallbackResponse: entries => [{
        id: entries[0].id,
        translatedText: '比较',
    }],
    messagePattern: /omitted.*segment/i,
}, {
    name: 'duplicate',
    fallbackResponse: entries => [{
        id: entries[0].id,
        translatedText: '比较',
    }, {
        id: entries[0].id,
        translatedText: '对比',
    }, {
        id: entries[1].id,
        translatedText: '和',
    }],
    messagePattern: /duplicate.*segment/i,
}, {
    name: 'unknown',
    fallbackResponse: entries => [...entries.map(entry => ({
        id: entry.id,
        translatedText: '译文',
    })), {
        id: 'unknown-segment',
        translatedText: '注入内容',
    }],
    messagePattern: /unknown.*segment/i,
}]) {
    test(`keeps the source after a ${name} protected text segment response`, async () => {
        let calls = 0;
        const source = 'Compare $x$ and $y$.';
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText(request) {
                    calls++;
                    const entries = parseTranslationRequest(
                        request.messages[1].content
                    );
                    if ('sourceText' in entries[0]) {
                        return { text: JSON.stringify(fallbackResponse(entries)) };
                    }
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedMarkdown: entry.sourceMarkdown.replace(
                                /MKTEROPROTECTED\d+PLACEHOLDER/,
                                ''
                            ),
                        }))),
                    };
                },
            },
            getSettings: () => ({ ...SETTINGS, streaming: false }),
            createCacheKey: async () => null,
        });

        const result = await service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: source,
        });

        assert.equal(calls, 4);
        assert.equal(result.translatedMarkdown, source);
        assert.equal(result.partial, true);
        assert.match(result.failedBlocks[0].message, messagePattern);
    });
}

test('keeps the source when the protected text fallback reaches its output limit', async () => {
    let calls = 0;
    const source = 'Compare $x$ and $y$.';
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                if ('sourceText' in entries[0]) {
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedText: '译文',
                        }))),
                        finishReason: 'length',
                    };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.replace(
                            /MKTEROPROTECTED\d+PLACEHOLDER/,
                            ''
                        ),
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(calls, 4);
    assert.equal(result.translatedMarkdown, source);
    assert.equal(result.partial, true);
    assert.match(result.failedBlocks[0].message, /output token limit/i);
});

test('propagates cancellation from the protected text fallback', async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                if ('sourceText' in entries[0]) {
                    controller.abort();
                    return { text: '[]' };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.replace(
                            /MKTEROPROTECTED\d+PLACEHOLDER/,
                            ''
                        ),
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Compare $x$ and $y$.',
        signal: controller.signal,
    }), error => error?.name === 'AbortError');
    assert.equal(calls, 4);
});

test('does not use the protected text fallback for ordinary structure errors', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: '# Wrong structure',
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(requests.length, 3);
    assert.ok(requests.flat().every(entry => 'sourceMarkdown' in entry));
    assert.equal(result.partial, true);
    assert.equal(result.translatedMarkdown, 'One paragraph.');
});

test('retries every block after the initial batch request fails', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                throw Object.assign(new Error('bad response'), {
                    code: 'AI_INVALID_RESPONSE',
                });
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(calls, 5);
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.translatedMarkdown, '# Paper\n\nParagraph.');
});

for (const code of [
    'AI_AUTH_ERROR',
    'AI_RATE_LIMITED',
    'AI_REQUEST_TIMEOUT',
    'AI_NETWORK_ERROR',
    'AI_HTTP_ERROR',
    'AI_RESPONSE_TOO_LARGE',
]) {
    test(`does not retry a fatal ${code} provider error`, async () => {
        let calls = 0;
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText() {
                    calls++;
                    throw Object.assign(new Error('provider failed'), { code });
                },
            },
            getSettings: () => ({ ...SETTINGS, streaming: false }),
            createCacheKey: async () => null,
        });

        await assert.rejects(() => service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: '# Paper\n\nParagraph.',
        }), error => error?.code === code);
        assert.equal(calls, 1);
    });
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('aborts every active section request when the document signal is canceled', async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = 0;
    let resolveStarted;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                if (calls === 5) resolveStarted();
                await new Promise((resolve, reject) => {
                    const abort = () => {
                        aborted++;
                        reject(Object.assign(new Error('aborted'), {
                            name: 'AbortError',
                        }));
                    };
                    request.signal.addEventListener('abort', abort, { once: true });
                });
                return { text: '' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = Array.from({ length: 7 }, (_, index) => (
        `# Section ${index}\n\nParagraph ${index}.`
    )).join('\n\n');
    const translation = service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
        signal: controller.signal,
    });
    await started;
    controller.abort();

    await assert.rejects(translation, error => error?.name === 'AbortError');
    assert.equal(calls, 5);
    assert.equal(aborted, 5);
});

function createBoundaryService({ output, onProviderCall = () => {} }) {
    return new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                onProviderCall();
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        output
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });
}

function translateSingleBlockRequest(requestMarkdown, translatedMarkdown) {
    const entries = parseTranslationRequest(requestMarkdown);
    if (entries.length !== 1) throw new Error('A single-block request is required');
    return JSON.stringify([{
        id: entries[0].id,
        translatedMarkdown,
    }]);
}

function translateMarkedSection(requestMarkdown, translatedHeading) {
    const index = translatedHeading.match(/(\d+)$/)?.[1] || 0;
    return JSON.stringify(parseTranslationRequest(requestMarkdown).map(entry => ({
        id: entry.id,
        translatedMarkdown: entry.sourceMarkdown
            .replace(`# Section ${index}`, translatedHeading)
            .replace(`Paragraph ${index}.`, `译文段落 ${index}。`),
    })));
}

function translateBatchRequest(requestMarkdown, translate) {
    return JSON.stringify(parseTranslationRequest(requestMarkdown).map(entry => ({
        id: entry.id,
        translatedMarkdown: translate(entry.sourceMarkdown),
    })));
}

function parseTranslationRequest(request) {
    const entries = JSON.parse(request);
    if (!Array.isArray(entries)) throw new Error('A JSON translation batch is required');
    return entries;
}
