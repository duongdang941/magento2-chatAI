import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { executeRegisteredMagentoTool } from '../services/tools/magento-tool-executor.js';

test('keeps guest order authorization in the shared executor boundary', async () => {
    const result = await executeRegisteredMagentoTool('getGuestOrders', {}, {});
    assert.equal(result.status, 'requires_customer_action');
    assert.equal(result.reason, 'guest_access_required');
});

test('rejects unregistered tools instead of provider-specific fallthrough', async () => {
    const result = await executeRegisteredMagentoTool('readEntireDatabase', {}, {});
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'unknown_tool');
});

test('normalizes both cart mutations through the browser session bridge', async () => {
    const calls = [];
    const context = { requestBrowserCart: async (payload) => (calls.push(payload), { status: 'success' }) };
    await executeRegisteredMagentoTool('addToCart', { sku: 'ABC', qty: 2 }, context);
    await executeRegisteredMagentoTool('removeFromCart', { sku: 'ABC' }, context);

    assert.equal(calls[0].sku, 'ABC');
    assert.equal(calls[1].action, 'remove');
});

test('shares guest category taxonomy reads through the catalog-version cache', async () => {
    const originalGet = axios.get;
    const originalSecret = process.env.AI_NODE_SYNC_SECRET;
    const cacheCalls = [];
    const stored = new Map();
    let requests = 0;

    process.env.AI_NODE_SYNC_SECRET = 'a'.repeat(32);
    axios.get = async () => {
        requests += 1;
        return {
            data: {
                data: [{ id: 9, name: 'Textilien', product_count: 3 }]
            }
        };
    };

    const runtime = {
        async getCacheVersion(namespace) {
            assert.equal(namespace, 'catalog');
            return 7;
        },
        async getOrSetJsonCache(namespace, identity, options, loader) {
            cacheCalls.push({ namespace, identity, options });
            const key = `${namespace}:${identity}`;
            if (stored.has(key)) return { value: stored.get(key), cacheHit: true };
            const value = await loader();
            stored.set(key, value);
            return { value, cacheHit: false };
        }
    };

    try {
        const context = {
            runtime,
            token: 'guest-session-one',
            magentoBaseUrl: 'https://store.example'
        };
        const first = await executeRegisteredMagentoTool('listCategories', {}, context);
        const second = await executeRegisteredMagentoTool('listCategories', {}, {
            ...context,
            token: 'guest-session-two'
        });

        assert.deepEqual(first, { data: [{ id: 9, name: 'Textilien', product_count: 3 }], meta: {} });
        assert.deepEqual(second, first);
        assert.equal(requests, 1);
        assert.equal(cacheCalls.length, 2);
        assert.equal(cacheCalls[0].namespace, 'catalog-categories');
        assert.equal(cacheCalls[0].options.ttlMs, 5 * 60_000);
        assert.match(cacheCalls[0].identity, /catalog_version/);
        assert.equal(cacheCalls[0].identity, cacheCalls[1].identity);
    } finally {
        axios.get = originalGet;
        if (originalSecret === undefined) {
            delete process.env.AI_NODE_SYNC_SECRET;
        } else {
            process.env.AI_NODE_SYNC_SECRET = originalSecret;
        }
    }
});
