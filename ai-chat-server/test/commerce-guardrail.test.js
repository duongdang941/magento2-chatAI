import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCommerceTool } from '../services/policy/commerce-guardrail.js';

test('uses canonical tool policy rather than language-specific text rules', () => {
    assert.deepEqual(
        authorizeCommerceTool({ name: 'getRecentOrders', config: { features: { guardrails_enabled: true } }, options: {} }),
        { allowed: false, reason: 'authenticated_customer_required', risk: 'read' }
    );
    assert.equal(
        authorizeCommerceTool({ name: 'getRecentOrders', config: { features: { guardrails_enabled: true } }, options: { customerId: 8 } }).allowed,
        true
    );
});

test('requires an explicit structured confirmation for destructive tools', () => {
    const base = { name: 'cancelOrder', config: { features: { guardrails_enabled: true } }, options: { customerId: 8 } };
    assert.equal(authorizeCommerceTool({ ...base, args: { orderNumber: '10001', confirmed: false } }).reason, 'explicit_confirmation_required');
    assert.equal(authorizeCommerceTool({ ...base, args: { orderNumber: '10001', confirmed: true } }).allowed, true);
});
