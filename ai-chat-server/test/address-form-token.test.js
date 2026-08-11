import assert from 'node:assert/strict';
import test from 'node:test';

import { issueAddressFormToken, verifyAddressFormToken } from '../services/address-form-token.js';

const SECRET = 'test-address-form-secret-that-is-long-enough';

test('binds an account address form to the verified customer, form and address type', () => {
    const token = issueAddressFormToken({
        formId: 'customer-address-1',
        resourceType: 'customer_account',
        customerId: 7,
        conversationId: 21,
        expiresAt: Date.now() + 60000,
        addressTypes: ['billing', 'shipping']
    }, SECRET);

    assert.equal(verifyAddressFormToken(token, {
        formId: 'customer-address-1',
        resourceType: 'customer_account',
        customerId: 7,
        conversationId: 21,
        addressType: 'shipping'
    }, SECRET).valid, true);
    assert.equal(verifyAddressFormToken(token, {
        formId: 'customer-address-1',
        resourceType: 'customer_account',
        customerId: 8,
        conversationId: 21,
        addressType: 'shipping'
    }, SECRET).valid, false);
    assert.equal(verifyAddressFormToken(token, {
        formId: 'customer-address-1',
        resourceType: 'customer_account',
        customerId: 7,
        conversationId: 21,
        addressType: 'billing'
    }, 'different-secret-that-is-also-long-enough').valid, false);
});

test('rejects expired and cross-session order address form tokens', () => {
    const expired = issueAddressFormToken({
        formId: 'expired',
        resourceType: 'order',
        sessionId: 'guest-a',
        conversationId: 21,
        orderNumber: '1001',
        expiresAt: Date.now() - 1,
        addressTypes: ['shipping']
    }, SECRET);
    assert.equal(expired, '');

    const token = issueAddressFormToken({
        formId: 'order-address-1',
        resourceType: 'order',
        sessionId: 'guest-a',
        conversationId: 21,
        orderNumber: '1001',
        expiresAt: Date.now() + 60000,
        addressTypes: ['shipping']
    }, SECRET);
    const result = verifyAddressFormToken(token, {
        formId: 'order-address-1',
        resourceType: 'order',
        sessionId: 'guest-b',
        conversationId: 21,
        orderNumber: '1001',
        addressType: 'shipping'
    }, SECRET);
    assert.equal(result.valid, false);
});
