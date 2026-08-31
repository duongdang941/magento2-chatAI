import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createProviderError,
    formatProviderError,
    providerErrorCode,
    readProviderErrorResponse
} from '../services/providers/provider-error.js';

test('provider errors never expose HTML or provider body to the shopper', async () => {
    const response = new Response('<html><body><h1>530 Origin DNS Error</h1></body></html>', {
        status: 530,
        headers: { 'content-type': 'text/html' }
    });
    const error = await readProviderErrorResponse(response);

    assert.equal(error.code, 'provider_unavailable');
    assert.equal(formatProviderError(error), 'AI provider is temporarily unavailable. Please try again shortly.');
    assert.doesNotMatch(formatProviderError(error), /<html|530 Origin DNS/i);
});

test('oversized provider bodies are discarded before parsing', async () => {
    const response = new Response('x'.repeat(20000), { status: 502 });
    const error = await readProviderErrorResponse(response);
    assert.equal(error.code, 'provider_unavailable');
    assert.match(formatProviderError(error), /temporarily unavailable/);
});

test('provider error codes remain stable for authentication failures', () => {
    const error = createProviderError('{"error":{"message":"invalid api key"}}', 401);
    assert.equal(error.code, 'provider_auth_failed');
    assert.match(formatProviderError(error), /credentials/);
});

test('provider error classification preserves normalized codes and transport failures', () => {
    assert.equal(providerErrorCode({ code: 'provider_unavailable' }), 'provider_unavailable');
    assert.equal(providerErrorCode(new Error('fetch failed')), 'provider_unavailable');
    assert.equal(providerErrorCode({ code: 'EAI_AGAIN' }), 'provider_unavailable');
});
