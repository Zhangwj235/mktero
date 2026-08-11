import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_API_BASE_PREF,
    AI_API_KEY_PREF,
    AI_CACHE_ENABLED_PREF,
    AI_ENABLED_PREF,
    AI_MAX_OUTPUT_TOKENS_PREF,
    AI_MODEL_PREF,
    AI_PROVIDER_PREF,
    AI_REQUEST_TIMEOUT_PREF,
    AI_TARGET_LANGUAGE_PREF,
    getAISettings,
    normalizeAIBaseURL,
    validateAISettings,
} from '../src/config/ai-preferences.js';

test('reads and normalizes the configured AI settings', () => {
    const values = new Map([
        [AI_ENABLED_PREF, true],
        [AI_PROVIDER_PREF, 'openai-compatible'],
        [AI_API_BASE_PREF, ' https://example.com/v1/ '],
        [AI_API_KEY_PREF, ' secret-token '],
        [AI_MODEL_PREF, ' example-chat '],
        [AI_TARGET_LANGUAGE_PREF, 'zh-CN'],
        [AI_REQUEST_TIMEOUT_PREF, 45_000],
        [AI_MAX_OUTPUT_TOKENS_PREF, 3_000],
        [AI_CACHE_ENABLED_PREF, false],
    ]);
    const settings = getAISettings({
        Prefs: { get: key => values.get(key) },
    });

    assert.deepEqual(settings, {
        enabled: true,
        provider: 'openai-compatible',
        apiBase: 'https://example.com/v1',
        apiKey: 'secret-token',
        model: 'example-chat',
        targetLanguage: 'zh-CN',
        requestTimeoutMs: 45_000,
        maxOutputTokens: 3_000,
        cacheEnabled: false,
    });
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

test('requires an enabled supported provider, model, and remote API key', () => {
    assert.throws(
        () => validateAISettings({ enabled: false }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'anthropic',
            apiBase: 'https://api.example.com/v1',
            apiKey: 'token',
            model: 'model',
        }),
        error => error?.code === 'AI_PROVIDER_UNSUPPORTED'
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'openai-compatible',
            apiBase: 'https://api.example.com/v1',
            apiKey: '',
            model: 'model',
        }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.doesNotThrow(() => validateAISettings({
        enabled: true,
        provider: 'openai-compatible',
        apiBase: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen3',
    }));
});

test('rejects oversized or control-bearing AI preference values', () => {
    const valid = {
        enabled: true,
        provider: 'openai-compatible',
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
