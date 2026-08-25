import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getProviderCapabilities,
    validateProviderConfiguration
} from '../services/providers/provider-capabilities.js';

test('reports only the configured Gemini capabilities without exposing credentials', () => {
    const capabilities = getProviderCapabilities({
        provider: 'gemini',
        api_key: 'secret-that-must-not-be-in-the-result',
        grounding_model: 'gemini-2.5-flash',
        image_generation: { enabled: true, model: 'gemini-3.1-flash-image' },
        voice: { enabled: true, transcription_model: 'gemini-3.1-flash-lite' }
    });

    assert.equal(capabilities.contract_version, 1);
    assert.equal(capabilities.chat.available, true);
    assert.equal(capabilities.commerce_tools.available, true);
    assert.equal(capabilities.image_generation.available, true);
    assert.equal(capabilities.voice_dictation.available, true);
    assert.equal(capabilities.native_web_grounding.available, true);
    assert.equal(capabilities.live_voice.supported, false);
    assert.equal(capabilities.video_generation.available, false);
    assert.equal(capabilities.video_generation.reason, 'video_generation_not_implemented');
    assert.equal(JSON.stringify(capabilities).includes('secret-that-must-not-be-in-the-result'), false);
});

test('keeps OpenAI Realtime separate from ordinary provider credentials', () => {
    const capabilities = getProviderCapabilities({
        provider: 'openai',
        api_key: 'chat-key',
        image_generation: { enabled: true, model: 'gpt-image-2' },
        voice: {
            enabled: true,
            transcription_model: 'gpt-4o-mini-transcribe',
            live: { enabled: true, api_key: 'realtime-key', model: 'gpt-realtime-1.5' }
        }
    });

    assert.equal(capabilities.live_voice.available, true);
    assert.equal(capabilities.native_web_grounding.supported, false);
});

test('rejects an enabled chat provider without an API key but permits a disabled store', () => {
    const enabled = validateProviderConfiguration({
        enabled: true,
        provider: 'gemini',
        api_key: '',
        image_generation: { enabled: false },
        voice: { enabled: false }
    });
    assert.equal(enabled.errors[0].code, 'provider_api_key_missing');

    const disabled = validateProviderConfiguration({
        enabled: false,
        provider: 'gemini',
        api_key: '',
        image_generation: { enabled: true },
        voice: { enabled: true }
    });
    assert.deepEqual(disabled.errors, []);
    assert.deepEqual(disabled.warnings, []);
});

test('accepts a Magento-defined provider code by its synchronized API format', () => {
    const capabilities = getProviderCapabilities({
        provider: 'gemini-custom',
        api_format: 'anthropic-messages',
        api_key: 'provider-key'
    });

    assert.equal(capabilities.protocol, 'anthropic');
    assert.equal(capabilities.chat.available, true);
    assert.equal(capabilities.commerce_tools.available, true);
});

test('does not advertise images for a custom chat-only provider model', () => {
    const capabilities = getProviderCapabilities({
        provider: 'gemini-tunnel',
        api_format: 'anthropic-messages',
        api_key: 'provider-key',
        model: 'ag/gemini-3.6-flash-high',
        models: [{
            id: 'ag/gemini-3.6-flash-high',
            capabilities: { image_generation: false }
        }],
        image_generation: { enabled: true, model: 'gemini-3.1-flash-image' }
    });

    assert.equal(capabilities.image_generation.supported, false);
    assert.equal(capabilities.image_generation.available, false);
    assert.equal(capabilities.image_generation.reason, 'model_image_generation_unsupported');
});

test('keeps checked image capability available through the safe SVG fallback when a custom model has no Image API', () => {
    const capabilities = getProviderCapabilities({
        provider: 'custom-openai',
        api_format: 'openai-chat-completions',
        api_key: 'provider-key',
        model: 'chat-only-image-model',
        models: [{
            id: 'chat-only-image-model',
            capabilities: { image_generation: true }
        }],
        image_generation: { enabled: true }
    });

    assert.equal(capabilities.image_generation.supported, false);
    assert.equal(capabilities.image_generation.available, true);
    assert.equal(capabilities.image_generation.reason, '');
});
