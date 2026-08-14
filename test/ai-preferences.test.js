import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_API_BASE_PREF,
    AI_API_KEY_PREF,
    AI_ENABLED_PREF,
    AI_MAX_OUTPUT_TOKENS_PREF,
    AI_MODEL_PREF,
    AI_PROTOCOL_OPENAI_CHAT,
    AI_PROTOCOL_OPENAI_RESPONSES,
    AI_PROTOCOL_PREF,
    AI_PROVIDER_PREF,
    AI_REQUEST_TIMEOUT_PREF,
    AI_STREAMING_PREF,
    AI_TARGET_LANGUAGE_PREF,
    getAISettings,
    isSupportedAITargetLanguage,
    normalizeAIBaseURL,
    validateAISettings,
} from '../src/config/ai-preferences.js';

test('reads and normalizes the configured AI settings', () => {
    const values = new Map([
        [AI_ENABLED_PREF, true],
        [AI_PROVIDER_PREF, 'openai'],
        [AI_PROTOCOL_PREF, AI_PROTOCOL_OPENAI_RESPONSES],
        [AI_API_BASE_PREF, ' https://example.com/v1/ '],
        [AI_API_KEY_PREF, ' secret-token '],
        [AI_MODEL_PREF, ' example-chat '],
        [AI_TARGET_LANGUAGE_PREF, 'zh-CN'],
        [AI_REQUEST_TIMEOUT_PREF, 45_000],
        [AI_MAX_OUTPUT_TOKENS_PREF, 3_000],
        [AI_STREAMING_PREF, false],
    ]);
    const settings = getAISettings({
        Prefs: { get: key => values.get(key) },
    });

    assert.deepEqual(settings, {
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://example.com/v1',
        apiKey: 'secret-token',
        model: 'example-chat',
        reasoning: 'provider-default',
        targetLanguage: 'zh-CN',
        requestTimeoutMs: 45_000,
        maxOutputTokens: 3_000,
        streaming: false,
    });
});

test('uses full-document request defaults and preserves a streaming opt-out', () => {
    const defaults = getAISettings({ Prefs: { get: () => undefined } });
    assert.equal(defaults.streaming, true);
    assert.equal(defaults.requestTimeoutMs, 600_000);
    assert.equal(defaults.maxOutputTokens, 0);
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_STREAMING_PREF ? false : undefined,
        },
    }).streaming, false);
    assert.equal(validateAISettings({
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://api.example.com/v1',
        apiKey: 'token',
        model: 'model',
    }).streaming, true);
});

test('allows full-document timeout and output token budgets', () => {
    const settings = getAISettings({
        Prefs: {
            get: key => ({
                [AI_REQUEST_TIMEOUT_PREF]: 3_600_001,
                [AI_MAX_OUTPUT_TOKENS_PREF]: 262_145,
            })[key],
        },
    });

    assert.equal(settings.requestTimeoutMs, 3_600_000);
    assert.equal(settings.maxOutputTokens, 262_144);
});

test('uses model-default reasoning without reading the legacy preference', () => {
    const reads = [];
    const settings = getAISettings({
        Prefs: {
            get(key) {
                reads.push(key);
                return key === 'extensions.mktero.aiReasoning'
                    ? 'high'
                    : undefined;
            },
        },
    });

    assert.equal(settings.reasoning, 'provider-default');
    assert.equal(reads.includes('extensions.mktero.aiReasoning'), false);
});

test('accepts the expanded AI translation language choices', () => {
    for (const targetLanguage of ['es-ES', 'fr-FR', 'pt-BR']) {
        assert.equal(
            getAISettings({
                Prefs: {
                    get: key => key === AI_TARGET_LANGUAGE_PREF
                        ? targetLanguage
                        : undefined,
                },
            }).targetLanguage,
            targetLanguage
        );
        assert.equal(
            validateAISettings({
                enabled: true,
                provider: 'openai',
                protocol: AI_PROTOCOL_OPENAI_RESPONSES,
                apiBase: 'https://api.example.com/v1',
                apiKey: 'token',
                model: 'model',
                targetLanguage,
            }).targetLanguage,
            targetLanguage
        );
    }
});

test('shares one supported target-language set with translation rendering', () => {
    assert.equal(isSupportedAITargetLanguage('zh-TW'), true);
    assert.equal(isSupportedAITargetLanguage(' pt-BR '), true);
    assert.equal(isSupportedAITargetLanguage('de-DE'), false);
    assert.equal(
        isSupportedAITargetLanguage('en-US" onclick="alert(1)'),
        false
    );
});

test('allows HTTPS providers and local HTTP model servers', () => {
    assert.equal(
        normalizeAIBaseURL('https://api.example.com/v1/'),
        'https://api.example.com/v1'
    );
    assert.equal(
        normalizeAIBaseURL('http://127.0.0.1:11434/v1/'),
        'http://127.0.0.1:11434/v1'
    );
    assert.throws(
        () => normalizeAIBaseURL('http://example.com/v1'),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => normalizeAIBaseURL('file:///tmp/model'),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.equal(getAISettings({
        Prefs: { get: key => key === AI_API_BASE_PREF ? '' : undefined },
    }).apiBase, '');
});

test('requires an enabled supported provider, protocol, model, and remote API key', () => {
    assert.throws(
        () => validateAISettings({ enabled: false }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'unsupported',
            apiBase: 'https://api.example.com/v1',
            apiKey: 'token',
            model: 'model',
        }),
        error => error?.code === 'AI_PROVIDER_UNSUPPORTED'
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'openai',
            protocol: AI_PROTOCOL_OPENAI_RESPONSES,
            apiBase: 'https://api.example.com/v1',
            apiKey: '',
            model: 'model',
        }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.doesNotThrow(() => validateAISettings({
        enabled: true,
        provider: 'custom',
        protocol: AI_PROTOCOL_OPENAI_CHAT,
        apiBase: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen3',
    }));
});

test('rejects oversized or control-bearing AI preference values', () => {
    const valid = {
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://api.example.com/v1',
        apiKey: 'token',
        model: 'model',
    };

    assert.throws(
        () => normalizeAIBaseURL(`https://example.com/${'x'.repeat(2_048)}`),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({ ...valid, apiKey: 'token\nInjected: value' }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({ ...valid, model: 'x'.repeat(513) }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
});

test('migrates the legacy OpenAI-compatible provider to Chat Completions', () => {
    const settings = getAISettings({
        Prefs: {
            get: key => ({
                [AI_ENABLED_PREF]: true,
                [AI_PROVIDER_PREF]: 'openai-compatible',
                [AI_PROTOCOL_PREF]: AI_PROTOCOL_OPENAI_RESPONSES,
                [AI_API_BASE_PREF]: 'https://api.example.com/v1',
                [AI_API_KEY_PREF]: 'token',
                [AI_MODEL_PREF]: 'legacy-model',
            })[key],
        },
    });

    assert.equal(settings.provider, 'custom');
    assert.equal(settings.protocol, AI_PROTOCOL_OPENAI_CHAT);
});

test('rejects provider and protocol combinations that cannot be routed', () => {
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'anthropic',
            protocol: AI_PROTOCOL_OPENAI_RESPONSES,
            apiBase: 'https://api.anthropic.com/v1',
            apiKey: 'token',
            model: 'claude-model',
        }),
        error => error?.code === 'AI_PROVIDER_UNSUPPORTED'
    );
});
