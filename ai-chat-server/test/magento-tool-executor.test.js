import test from 'node:test';
import assert from 'node:assert/strict';

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
