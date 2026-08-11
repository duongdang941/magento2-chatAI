import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildMagentoSigningUrl,
    createInternalMagentoRequestConfig,
    createMagentoRequestConfig,
    hasMagentoOAuthCredentials,
    normalizeMagentoHostHeader
} from '../services/magento-auth.js';
import crypto from 'node:crypto';

test('normalizeMagentoHostHeader accepts plain hosts and full URLs', () => {
    assert.equal(normalizeMagentoHostHeader('afd.test'), 'afd.test');
    assert.equal(normalizeMagentoHostHeader('http://afd.test/'), 'afd.test');
    assert.equal(normalizeMagentoHostHeader('https://shop.example.com:8443/base/'), 'shop.example.com:8443');
    assert.equal(normalizeMagentoHostHeader(''), '');
});

test('buildMagentoSigningUrl signs loopback requests with Magento host', () => {
    assert.equal(
        buildMagentoSigningUrl('http://127.0.0.1/rest/V1/afd-ai/conversations/create', 'afd.test'),
        'http://afd.test/rest/V1/afd-ai/conversations/create'
    );
});

test('buildMagentoSigningUrl supports an explicit signing base URL', () => {
    assert.equal(
        buildMagentoSigningUrl(
            'http://127.0.0.1/rest/V1/afd-ai/categories?limit=5',
            'ignored.test',
            'https://shop.example.com'
        ),
        'https://shop.example.com/rest/V1/afd-ai/categories?limit=5'
    );
});

test('creates an OAuth signature from the Magento-synced credentials', () => {
    const magentoOauth = {
        consumer_key: 'consumer-key',
        consumer_secret: 'consumer-secret',
        access_token: 'access-token',
        access_token_secret: 'access-token-secret'
    };

    const requestConfig = createMagentoRequestConfig(
        'GET',
        'http://127.0.0.1/rest/V1/afd-ai/products/search',
        {
            magentoOauth,
            signParams: { query: 'shirt' }
        }
    );

    assert.equal(hasMagentoOAuthCredentials(magentoOauth), true);
    assert.match(requestConfig.headers.Authorization, /^OAuth /);
    assert.match(requestConfig.headers.Authorization, /oauth_consumer_key="consumer-key"/);
    assert.match(requestConfig.headers.Authorization, /oauth_token="access-token"/);
    assert.doesNotMatch(requestConfig.headers.Authorization, /consumer-secret|access-token-secret/);
    assert.equal(requestConfig.paramsSerializer.encode('Faltfächer Sonnenaufgang'), 'Faltf%C3%A4cher%20Sonnenaufgang');
});

test('keeps an explicit empty query in the signed Magento parameters', () => {
    const requestConfig = createMagentoRequestConfig(
        'GET',
        'http://127.0.0.1/rest/V1/afd-ai/products/search',
        {
            magentoOauth: {
                consumer_key: 'consumer-key',
                consumer_secret: 'consumer-secret',
                access_token: 'access-token',
                access_token_secret: 'access-token-secret'
            },
            signParams: { query: '', categoryId: 42 }
        }
    );

    assert.match(requestConfig.headers.Authorization, /^OAuth /);
    assert.equal(requestConfig.paramsSerializer.encode(''), '');
});

test('internal Magento requests bind a single-use nonce into the HMAC signature', () => {
    const previousSecret = process.env.AI_NODE_SYNC_SECRET;
    process.env.AI_NODE_SYNC_SECRET = 'internal-test-secret-that-is-at-least-32-characters';
    try {
        const body = JSON.stringify({ conversationId: 7 });
        const config = createInternalMagentoRequestConfig(
            'POST',
            'http://127.0.0.1/rest/V1/afd-ai/conversations/touch',
            body
        );
        const timestamp = config.headers['X-Afd-AI-Internal-Timestamp'];
        const nonce = config.headers['X-Afd-AI-Internal-Nonce'];
        const expected = crypto
            .createHmac('sha256', process.env.AI_NODE_SYNC_SECRET)
            .update(`${timestamp}.${nonce}.POST./rest/V1/afd-ai/conversations/touch.${body}`, 'utf8')
            .digest('hex');

        assert.match(nonce, /^[a-f0-9]{32}$/);
        assert.equal(config.headers['X-Afd-AI-Internal-Signature'], expected);
    } finally {
        if (previousSecret === undefined) delete process.env.AI_NODE_SYNC_SECRET;
        else process.env.AI_NODE_SYNC_SECRET = previousSecret;
    }
});
