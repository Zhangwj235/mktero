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
    assert.equal(request.settings.reasoning, 'provider-default');
    assert.equal(request.maxOutputTokens, 4);
    assert.deepEqual(request.messages, [{
        role: 'user',
        content: 'hi',
    }]);
});

test('translates a complete Markdown document block by block', async () => {
    const requests = [];
    const progress = [];
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request.messages[1].content);
                return {
                    text: requests.length === 1 ? '# 论文' : '译文段落。',
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

    assert.deepEqual(requests, ['# Paper', 'Original paragraph.']);
    assert.equal(
        result.translatedMarkdown,
        '# 论文\n\n译文段落。\n\n```js\ncode();\n```'
    );
    assert.match(result.comparisonMarkdown, /# Paper\n\n> # 论文/);
    assert.equal(result.totalBlocks, 2);
    assert.equal(result.completedBlocks, 2);
    assert.equal(result.cacheHit, false);
    assert.deepEqual(progress, [{ completed: 1, total: 2 }, {
        completed: 2,
        total: 2,
    }]);
    assert.equal(cached.length, 1);
    assert.equal(cached[0][0], 'a'.repeat(64));
    assert.equal(cached[0][1], 'c'.repeat(64));
    assert.equal(cached[0][2].translatedMarkdown, result.translatedMarkdown);
});

test('streams document blocks by default and uses the selected language', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                requests.push(request);
                return { text: '# Article traduit', model: 'stream-model' };
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

test('isolates document translations by reasoning and source content', async () => {
    const cacheInputs = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => ({ text: '# 论文' }),
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
            generateText: async () => ({ text: '# 论文' }),
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
    assert.deepEqual(cacheErrors, ['disk full']);
});

test('continues translating without persistence when cache hashing fails', async () => {
    const cacheErrors = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                providerCalls++;
                return { text: '# 论文' };
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
    assert.equal(providerCalls, 1);
    assert.deepEqual(cacheErrors, ['hash unavailable', 'hash unavailable']);
});

test('continues translating when reading the Markdown translation cache fails', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => ({ text: '# 论文' }),
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
            generateText: async () => ({ text: '# 论文' }),
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
    test(`rejects ${name} returned by the AI provider`, async () => {
        const service = createBoundaryService({ output });

        await assert.rejects(() => service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: 'Translate this paragraph.',
        }), error => error?.code === 'AI_INVALID_RESPONSE');
    });
}

test('rejects a Markdown block over 64 KB before calling the provider', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: `Paragraph ${'x'.repeat(64 * 1024)}.`,
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('counts protected content toward the 64 KB input limit', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: `Translate \`${'x'.repeat(64 * 1024)}\`.`,
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

test('rejects a translated Markdown block over 256 KB', async () => {
    const service = createBoundaryService({
        output: `译文${'文'.repeat(256 * 1024)}`,
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Translate this paragraph.',
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
});

test('rejects a document translation over 4 MB without caching it', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: `译${'x'.repeat(255 * 1024)}`,
        onProviderCall: () => { providerCalls++; },
    });
    service.cache.putTranslation = assert.fail;

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: Array.from(
            { length: 17 },
            (_, index) => `Paragraph ${index}.`
        ).join('\n\n'),
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
    assert.equal(providerCalls, 17);
});

test('loads a complete document translation without calling the provider', async () => {
    const cached = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0-0-7-heading', markdown: '# 论文' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
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
        translationKey: 'c'.repeat(64),
        cacheHit: true,
        totalBlocks: 1,
        completedBlocks: 1,
    });
});

test('does not cache a partial document when a later block fails', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                if (calls === 2) throw new Error('provider failed');
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
    }), /provider failed/);
    assert.equal(calls, 2);
});

test('stops document translation before the next block when canceled', async () => {
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

function createBoundaryService({ output, onProviderCall = () => {} }) {
    return new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                onProviderCall();
                return { text: output };
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
