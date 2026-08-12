import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../services/configuration/config-service.js';

test('normalizes Magento agent, traffic, capacity and image limits', () => {
    const config = normalizeConfig({
        provider: 'cockpit',
        agent: {
            max_tool_rounds: 99,
            max_tool_executions: 18,
            max_category_calls: 0,
            block_duplicate_tool_calls: false,
            max_output_tokens: 9000,
            max_model_history_messages: 2,
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
            max_images_per_message: 99
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
        max_images_per_message: 4
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
    assert.equal(config.agent.max_category_calls, 3);
    assert.equal(config.agent.block_duplicate_tool_calls, true);
    assert.equal(config.image_generation.customer_per_hour, 3);
    assert.equal(config.image_generation.guest_per_day, 5);
    assert.equal(config.capacity.model_lease_ms, 180000);
    assert.equal(config.attachments.max_image_bytes, 4194304);
    assert.equal(config.attachments.max_images_per_message, 4);
    assert.equal(config.voice.max_duration_seconds, 120);
    assert.equal(config.voice.max_audio_bytes, 4194304);
});
