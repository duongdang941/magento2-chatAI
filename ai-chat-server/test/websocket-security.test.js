import test from 'node:test';
import assert from 'node:assert/strict';

import {
    addConfiguredWebSocketOrigins,
    configuredWebSocketOrigins,
    createDistributedWebSocketConnectionAdmission,
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

test('uses renewable shared capacity leases across WebSocket replicas', async () => {
    const calls = [];
    let released = 0;
    const runtime = {
        async acquireScopedCapacity(namespace, identity, options) {
            calls.push({ namespace, identity, options });
            return {
                async renew() { return true; },
                async release() { released++; }
            };
        }
    };
    const admission = createDistributedWebSocketConnectionAdmission({
        runtime,
        globalLimit: 3,
        networkLimit: 2,
        leaseMs: 30000
    });
    const result = await admission.admit({ headers: {}, socket: { remoteAddress: '127.0.0.1' } });

    assert.equal(result.allowed, true);
    assert.equal(await result.renew(), true);
    await result.release();
    assert.equal(released, 2);
    assert.deepEqual(calls, [
        { namespace: 'websocket-global', identity: 'all', options: { concurrency: 3, leaseMs: 30000 } },
        { namespace: 'websocket-network', identity: '127.0.0.1', options: { concurrency: 2, leaseMs: 30000 } }
    ]);
});

test('releases the global shared lease when the network lease is unavailable', async () => {
    let releases = 0;
    const runtime = {
        async acquireScopedCapacity(namespace) {
            if (namespace === 'websocket-network') return null;
            return { async release() { releases++; }, async renew() { return true; } };
        }
    };
    const admission = createDistributedWebSocketConnectionAdmission({ runtime, globalLimit: 2, networkLimit: 1 });
    assert.deepEqual(
        await admission.admit({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
        { allowed: false, reason: 'network_cap' }
    );
    assert.equal(releases, 1);
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
        },
        tenants: {
            ['a'.repeat(64)]: {
                default: { magento_base_url: 'https://second-shop.example/' },
                stores: { french: { magento_base_url: 'https://fr.second-shop.example/' } }
            }
        }
    });

    assert.equal(allowedOrigins.has('https://shop.example'), true);
    assert.equal(allowedOrigins.has('https://de.shop.example'), true);
    assert.equal(allowedOrigins.has('https://second-shop.example'), true);
    assert.equal(allowedOrigins.has('https://fr.second-shop.example'), true);
    assert.equal(allowedOrigins.size, 4);
});
