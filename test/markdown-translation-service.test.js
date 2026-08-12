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
    cacheEnabled: true,
});

test('translates one Markdown block and stores the normalized result', async () => {
    const puts = [];
    let completion;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                completion = request;
                return {
                    text: '  翻译结果  ',
                    model: 'provider-model',
                    usage: { totalTokens: 12 },
                };
            },
        },
        cache: {
            get: async () => null,
            put: async (key, value) => puts.push({ key, value }),
        },
        getSettings: () => SETTINGS,
        createCacheKey: async value => `key:${value.length}`,
    });

    const result = await service.translate({
        documentKey: 'pdf-hash',
        blockID: 'paragraph-1',
        markdown: 'Source paragraph.',
    });

    assert.equal(completion.settings, SETTINGS);
    assert.equal(completion.messages[0].role, 'system');
    assert.match(completion.messages[0].content, /Simplified Chinese/);
    assert.deepEqual(completion.messages[1], {
        role: 'user',
        content: 'Source paragraph.',
    });
    assert.equal(result.text, '翻译结果');
    assert.equal(result.cacheHit, false);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].value, {
        text: '翻译结果',
        model: 'provider-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
    });
});

test('uses the configured expanded language name in the translation prompt', async () => {
    for (const [targetLanguage, languageName] of [
        ['es-ES', 'Spanish'],
        ['fr-FR', 'French'],
        ['pt-BR', 'Brazilian Portuguese'],
    ]) {
        let completion;
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText(request) {
                    completion = request;
                    return { text: 'Translated' };
                },
            },
            getSettings: () => ({ ...SETTINGS, targetLanguage }),
            createCacheKey: async () => `key:${targetLanguage}`,
        });

        await service.translate({
            documentKey: 'pdf-hash',
            blockID: 'paragraph-1',
            markdown: 'Source paragraph.',
        });

        assert.match(completion.messages[0].content, new RegExp(languageName));
    }
});

test('returns a matching cached translation without calling Chat', async () => {
    let calls = 0;
    const cached = {
        text: '缓存译文',
        model: 'example-chat',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
    };
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => { calls++; },
        },
        cache: {
            get: async () => cached,
            put: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'cached-key',
    });

    assert.deepEqual(await service.translate({
        documentKey: 'pdf-hash',
        blockID: 'paragraph-1',
        markdown: 'Source paragraph.',
    }), {
        ...cached,
        cacheHit: true,
        usage: null,
    });
    assert.equal(calls, 0);
});

test('isolates cached translations by reasoning level', async () => {
    const cacheInputs = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => ({ text: 'Translated' }),
        },
        getSettings: () => ({ ...SETTINGS, reasoning: 'high' }),
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'reasoning-cache-key';
        },
    });

    await service.translate({
        documentKey: 'pdf-hash',
        blockID: 'paragraph-1',
        markdown: 'Source paragraph.',
    });

    assert.equal(cacheInputs[0].reasoning, 'high');
});

test('uses the automatic reasoning cache bucket for missing or invalid settings', async () => {
    const cacheInputs = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => ({ text: 'Translated' }),
        },
        getSettings: () => ({ ...SETTINGS, reasoning: 'not-a-level' }),
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'automatic-cache-key';
        },
    });

    await service.translate({
        documentKey: 'pdf-hash',
        blockID: 'paragraph-1',
        markdown: 'Source paragraph.',
    });

    assert.equal(cacheInputs[0].reasoning, 'provider-default');
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
    assert.equal(request.maxOutputTokens, 8);
    assert.deepEqual(request.messages, [{
        role: 'user',
        content: 'Reply with exactly: OK',
    }]);
});

test('keeps a successful translation usable when cache operations fail', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async () => ({
                text: '译文',
                model: 'example-chat',
            }),
        },
        cache: {
            get: async () => { throw new Error('read failed'); },
            put: async () => { throw new Error('write failed'); },
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'cache-key',
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.translate({
        documentKey: 'pdf-hash',
        blockID: 'paragraph-1',
        markdown: 'Source paragraph.',
    });

    assert.equal(result.text, '译文');
    assert.equal(result.cacheHit, false);
    assert.deepEqual(cacheErrors, ['read failed', 'write failed']);
});

test('does not call Chat when AI is disabled or the block is oversized', async () => {
    let calls = 0;
    const createService = settings => new MarkdownTranslationService({
        aiGateway: { generateText: async () => { calls++; } },
        getSettings: () => settings,
        createCacheKey: async () => 'key',
    });

    await assert.rejects(
        createService({ ...SETTINGS, enabled: false }).translate({
            documentKey: 'pdf-hash',
            blockID: 'paragraph-1',
            markdown: 'Source paragraph.',
        }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    await assert.rejects(
        createService(SETTINGS).translate({
            documentKey: 'pdf-hash',
            blockID: 'paragraph-1',
            markdown: 'x'.repeat(65 * 1024),
        }),
        error => error?.code === 'AI_INPUT_TOO_LARGE'
    );
    assert.equal(calls, 0);
});

test('rejects missing or oversized cache identifiers before calling Chat', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: async () => { calls++; } },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'key',
    });

    for (const request of [{
        documentKey: '',
        blockID: 'paragraph-1',
    }, {
        documentKey: 'pdf-hash',
        blockID: 'x'.repeat(513),
    }]) {
        await assert.rejects(
            service.translate({ ...request, markdown: 'Source paragraph.' }),
            error => error?.code === 'AI_INVALID_REQUEST'
        );
    }
    assert.equal(calls, 0);
});
