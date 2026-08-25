import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../services/configuration/config-service.js';

test('normalizes Magento agent, traffic, capacity and image limits', () => {
    const config = normalizeConfig({
        provider: 'openai',
        agent: {
            max_tool_rounds: 99,
            max_tool_executions: 18,
            max_category_calls: 0,
            block_duplicate_tool_calls: false,
            max_output_tokens: 9000,
            max_model_history_messages: 2,
            max_history_tokens: 100,
            max_tool_context_tokens: 99999,
            provider_stream_timeout_ms: 5000
        },
        image_generation: {
            customer_per_hour: 7,
            customer_per_day: 21,
            guest_per_hour: 4,
            guest_per_day: 9,
            cooldown_seconds: 0,
            max_concurrent_per_identity: 8,
            timeout_ms: 500000
        },
        rate_limits: {
            messages_per_minute: 200,
            product_pages_per_minute: 0,
            address_updates_per_minute: 6,
            address_updates_per_hour: 40
        },
        capacity: {
            concurrent_model_requests: 48,
            queue_depth: -1,
            queue_wait_ms: 500,
            model_lease_ms: 700000
        },
        attachments: {
            max_image_bytes: 500,
            max_images_per_message: 99,
            max_total_image_bytes: 99_999_999,
            max_total_encoded_bytes: 1,
            max_total_pixels: 999_999_999,
            vision_concurrency: 0
        },
        voice: {
            max_duration_seconds: 999,
            max_audio_bytes: 500,
            requests_per_minute: 0,
            max_concurrent_per_identity: 8,
            timeout_ms: 5000,
            live: {
                enabled: true,
                api_key: 'realtime-test-key',
                model: 'gpt-realtime-2.1',
                max_sessions_per_minute: 999,
                max_duration_seconds: 9999
            }
        }
    });

    assert.deepEqual(config.agent, {
        max_tool_rounds: 12,
        max_tool_executions: 18,
        max_category_calls: 1,
        block_duplicate_tool_calls: false,
        max_output_tokens: 8192,
        max_model_history_messages: 4,
        max_history_tokens: 512,
        max_tool_context_tokens: 24000,
        provider_stream_timeout_ms: 10000
    });
    assert.equal(config.image_generation.customer_per_hour, 7);
    assert.equal(config.image_generation.cooldown_seconds, 0);
    assert.equal(config.image_generation.max_concurrent_per_identity, 3);
    assert.equal(config.image_generation.timeout_ms, 300000);
    assert.deepEqual(config.rate_limits, {
        messages_per_minute: 120,
        product_pages_per_minute: 1,
        address_updates_per_minute: 6,
        address_updates_per_hour: 40
    });
    assert.deepEqual(config.capacity, {
        concurrent_model_requests: 48,
        queue_depth: 1,
        queue_wait_ms: 1000,
        model_lease_ms: 600000
    });
    assert.deepEqual(config.attachments, {
        max_image_bytes: 262144,
        max_images_per_message: 4,
        max_total_image_bytes: 8388608,
        max_total_encoded_bytes: 524288,
        max_total_pixels: 50000000,
        vision_concurrency: 1,
        cost_units_per_minute: 30,
        network_cost_units_per_minute: 120,
        global_cost_units_per_minute: 1200
    });
    assert.deepEqual(config.voice, {
        enabled: true,
        transcription_model: 'gpt-4o-mini-transcribe',
        max_duration_seconds: 300,
        max_audio_bytes: 262144,
        requests_per_minute: 1,
        max_concurrent_per_identity: 2,
        timeout_ms: 10000,
        live: {
            enabled: true,
            api_key: 'realtime-test-key',
            model: 'gpt-realtime-2.1',
            max_sessions_per_minute: 30,
            max_duration_seconds: 1800
        }
    });
});

test('uses quality-first defaults when Magento has not pushed runtime settings', () => {
    const config = normalizeConfig({ provider: 'cockpit' });

    assert.equal(config.agent.max_tool_rounds, 8);
    assert.equal(config.agent.max_tool_executions, 15);
    assert.equal(config.agent.max_history_tokens, 12000);
    assert.equal(config.agent.max_tool_context_tokens, 6000);
    assert.equal(config.agent.max_category_calls, 3);
    assert.equal(config.agent.block_duplicate_tool_calls, true);
    assert.equal(config.image_generation.customer_per_hour, 3);
    assert.equal(config.image_generation.guest_per_day, 5);
    assert.equal(config.capacity.model_lease_ms, 180000);
    assert.equal(config.attachments.max_image_bytes, 4194304);
    assert.equal(config.attachments.max_images_per_message, 4);
    assert.equal(config.attachments.max_total_image_bytes, 6291456);
    assert.equal(config.attachments.max_total_encoded_bytes, 6291456);
    assert.equal(config.voice.max_duration_seconds, 120);
    assert.equal(config.voice.max_audio_bytes, 4194304);
});

test('disables OpenAI Live Voice when a different chat provider is selected', () => {
    const config = normalizeConfig({
        provider: 'gemini',
        voice: {
            live: {
                enabled: true,
                api_key: 'realtime-test-key',
                model: 'gpt-realtime-1.5'
            }
        }
    });

    assert.equal(config.voice.live.enabled, false);
});

test('normalizes Magento-owned Gemini grounding and rollout flags into a capability snapshot', () => {
    const config = normalizeConfig({
        provider: 'gemini',
        api_key: 'gemini-key',
        model: 'gemini-3.1-flash-lite',
        grounding_model: 'gemini-2.5-flash',
        image_generation: { enabled: true, model: 'gemini-3.1-flash-image' },
        voice: { enabled: true, transcription_model: 'gemini-3.1-flash-lite' },
        features: {
            candidate_memory_enabled: true,
            product_advisor_enabled: true,
            proactive_suggestions_enabled: false,
            analytics_attribution_enabled: true,
            guardrails_enabled: false
        }
    });

    assert.equal(config.grounding_model, 'gemini-2.5-flash');
    assert.deepEqual(config.features, {
        candidate_memory_enabled: true,
        product_advisor_enabled: true,
        proactive_suggestions_enabled: false,
        analytics_attribution_enabled: true,
        guardrails_enabled: false
    });
    assert.equal(config.capabilities.native_web_grounding.available, true);
    assert.equal(config.capabilities.image_generation.available, true);
});

test('does not source an unregistered provider key from a gateway environment variable', () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'gateway-gemini-key';
    try {
        assert.equal(normalizeConfig({ provider: 'gemini', api_key: '' }).api_key, '');
    } finally {
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
});

test('selects the Magento-synchronized custom provider and keeps the full registry', () => {
    const config = normalizeConfig({
        provider: 'gemini-custom',
        thought_level: 'xhigh',
        providers: {
            'gemini-custom': {
                provider_id: 2,
                name: 'Gemini tunnel',
                provider_code: 'gemini-custom',
                base_url: 'https://example.test/v1',
                api_key: 'custom-key',
                api_format: 'anthropic-messages',
                models: [{
                    id: 'gemini-3.6-flash',
                    context_window: 1000000,
                    reasoning_enabled: true,
                    reasoning_levels: ['low', 'high'],
                    reasoning_default_level: 'high'
                }],
                is_active: 1
            },
            cockpit: {
                name: 'Cockpit',
                provider_code: 'cockpit',
                base_url: 'http://127.0.0.1:49998/v1',
                api_key: 'cockpit-key',
                api_format: 'openai-chat-completions',
                models: [{ id: 'gpt-5.6-terra' }],
                is_active: 1
            }
        }
    });

    assert.equal(config.provider, 'gemini-custom');
    assert.equal(config.api_format, 'anthropic-messages');
    assert.equal(config.base_url, 'https://example.test/v1');
    assert.equal(config.api_key, 'custom-key');
    assert.equal(config.model, 'gemini-3.6-flash');
    assert.equal(config.models[0].max_output_tokens, null);
    assert.equal(config.models[0].max_output_tokens_configured, false);
    assert.equal(config.thought_level, 'high');
    assert.deepEqual(Object.keys(config.providers).sort(), ['cockpit', 'gemini-custom']);
    assert.equal(config.capabilities.protocol, 'anthropic');
});

test('keeps image capability on the selected model instead of guessing from the provider name', () => {
    const config = normalizeConfig({
        provider: 'gemini-tunnel',
        providers: {
            'gemini-tunnel': {
                provider_code: 'gemini-tunnel',
                base_url: 'https://tunnel.example/v1',
                api_key: 'provider-key',
                api_format: 'anthropic-messages',
                models: [{
                    id: 'ag/gemini-3.6-flash-high',
                    supports_images: false
                }]
            }
        }
    });

    assert.equal(config.image_generation.transport, '');
    assert.equal(config.capabilities.image_generation.reason, 'model_image_generation_unsupported');
});

test('treats a legacy provider-model 8192 default as no output limit', () => {
    const config = normalizeConfig({
        provider: 'legacy-provider',
        providers: {
            'legacy-provider': {
                provider_code: 'legacy-provider',
                base_url: 'https://provider.example/v1',
                api_key: 'provider-key',
                api_format: 'openai-chat-completions',
                models: [{ id: 'legacy-model', max_output_tokens: 8192 }]
            }
        }
    });

    assert.equal(config.models[0].max_output_tokens, null);
    assert.equal(config.models[0].max_output_tokens_configured, false);
});

test('uses Magento image transport configuration instead of model metadata', () => {
    const config = normalizeConfig({
        provider: 'gemini-custom',
        model: 'gemini-image-capable',
        providers: {
            'gemini-custom': {
                provider_code: 'gemini-custom',
                base_url: 'https://provider.example/v1',
                api_key: 'provider-key',
                api_format: 'anthropic-messages',
                models: [{
                    id: 'gemini-image-capable',
                    supports_images: true,
                    image_transport: 'gemini-generate-content'
                }]
            }
        },
        image_generation: { enabled: true, transport: '' }
    });

    assert.equal(config.image_generation.transport, '');
});

test('syncs a Responses image-tool model without requiring a separate GPT Image model', () => {
    const config = normalizeConfig({
        provider: 'cockpit-tool',
        providers: {
            'cockpit-tool': {
                provider_code: 'cockpit-tool',
                base_url: 'https://provider.example/v1',
                api_key: 'provider-key',
                api_format: 'openai-responses',
                models: [{
                    id: 'gpt-5.6-terra',
                    supports_images: true,
                    image_transport: 'openai-responses'
                }]
            }
        }
    });

    assert.equal(config.image_generation.transport, 'openai-responses');
    assert.equal(config.capabilities.image_generation.available, true);
});
