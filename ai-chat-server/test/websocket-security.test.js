import test from 'node:test';
import assert from 'node:assert/strict';

import {
    configuredWebSocketOrigins,
    isAllowedWebSocketOrigin
} from '../services/websocket-security.js';

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

test('permits originless local smoke clients outside production', () => {
    assert.equal(isAllowedWebSocketOrigin('', {
        env: { NODE_ENV: 'test' },
        allowedOrigins: new Set()
    }), true);
});
