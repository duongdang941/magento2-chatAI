import test from 'node:test';
import assert from 'node:assert/strict';

import {
    addConfiguredWebSocketOrigins,
    configuredWebSocketOrigins,
    createWebSocketConnectionAdmission,
    isAllowedWebSocketOrigin
} from '../services/security/websocket-security.js';

test('accepts only configured browser origins', () => {
    const env = {
        NODE_ENV: 'production',
        MAGENTO_API_URL: 'https://shop.example/rest',
        WS_ALLOWED_ORIGINS: 'https://admin.example'
    };
    const allowedOrigins = configuredWebSocketOrigins(env);

    assert.equal(isAllowedWebSocketOrigin('https://shop.example', { env, allowedOrigins }), true);
    assert.equal(isAllowedWebSocketOrigin('https://admin.example/path', { env, allowedOrigins }), true);
    assert.equal(isAllowedWebSocketOrigin('https://evil.example', { env, allowedOrigins }), false);
    assert.equal(isAllowedWebSocketOrigin('', { env, allowedOrigins }), false);
});

test('caps WebSocket connections per network and globally', () => {
    const admission = createWebSocketConnectionAdmission({ globalLimit: 2, networkLimit: 1 });
    const requestA = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const requestB = { headers: {}, socket: { remoteAddress: '127.0.0.2' } };
    const first = admission.admit(requestA, 0);
    assert.equal(first.allowed, true);
    assert.deepEqual(admission.admit(requestA, 1), { allowed: false, reason: 'network_cap' });
    const second = admission.admit(requestB, 1);
    assert.equal(second.allowed, true);
    assert.deepEqual(admission.admit({ headers: {}, socket: { remoteAddress: '127.0.0.3' } }, 2), {
        allowed: false, reason: 'global_cap'
    });
    first.release();
    assert.equal(admission.admit(requestA, 1).allowed, true);
    second.release();
});

test('permits originless local smoke clients outside production', () => {
    assert.equal(isAllowedWebSocketOrigin('', {
        env: { NODE_ENV: 'test' },
        allowedOrigins: new Set()
    }), true);
});

test('adds every synchronized Magento store origin to the allow-list', () => {
    const allowedOrigins = new Set();
    addConfiguredWebSocketOrigins(allowedOrigins, {
        default: { magento_base_url: 'https://shop.example/' },
        stores: {
            german: { magento_base_url: 'https://de.shop.example/store/' },
            ignored: { magento_base_url: 'not-a-url' }
        }
    });

    assert.equal(allowedOrigins.has('https://shop.example'), true);
    assert.equal(allowedOrigins.has('https://de.shop.example'), true);
    assert.equal(allowedOrigins.size, 2);
});
