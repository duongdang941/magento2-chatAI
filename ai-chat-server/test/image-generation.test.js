import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageGenerationRequest } from '../services/image-generation.js';

test('builds a Cockpit image generation request from synced Magento settings', () => {
    const request = buildImageGenerationRequest('A friendly brown puppy', {
        provider: 'cockpit',
        api_key: 'test-key',
        base_url: 'http://127.0.0.1:49998/v1',
        image_generation: {
            enabled: true,
            model: 'gpt-image-2',
            size: '1536x1024',
            quality: 'low'
        }
    });

    assert.equal(request.model, 'gpt-image-2');
    assert.equal(request.size, '1536x1024');
    assert.equal(request.quality, 'low');
    assert.deepEqual(request.body, {
        model: 'gpt-image-2',
        prompt: 'A friendly brown puppy',
        size: '1536x1024',
        quality: 'low',
        output_format: 'png'
    });
});

test('falls back to safe image defaults for unsupported dimensions and quality', () => {
    const request = buildImageGenerationRequest('A simple icon', {
        provider: 'cockpit',
        api_key: 'test-key',
        base_url: 'http://127.0.0.1:49998/v1',
        image_generation: {
            model: 'gpt-image-2',
            size: '999x999',
            quality: 'ultra'
        }
    });

    assert.equal(request.size, '1024x1024');
    assert.equal(request.quality, 'medium');
});
