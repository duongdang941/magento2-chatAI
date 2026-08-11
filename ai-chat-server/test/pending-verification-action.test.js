import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clearPendingVerificationAction,
    consumePendingVerificationAction,
    rememberPendingVerificationAction
} from '../services/pending-verification-action.js';

test('stores a safe, bounded pending verification action', () => {
    const client = {};
    const pending = rememberPendingVerificationAction(client, {
        purpose: 'support',
        conversationId: 42,
        text: 'I need a human',
        history: [{
            role: 'user',
            content: 'Earlier question',
            parts: [
                { text: 'Earlier question' },
                { inline_data: { mime_type: 'image/png', data: 'secret-base64' } }
            ]
        }]
    }, { now: 1000, ttlMs: 5000 });

    assert.equal(pending.purpose, 'support');
    assert.equal(pending.conversationId, 42);
    assert.equal(pending.expiresAt, 6000);
    assert.equal(JSON.stringify(pending).includes('secret-base64'), false);
});

test('consumes only the matching purpose and only once', () => {
    const client = {};
    rememberPendingVerificationAction(client, {
        purpose: 'support',
        conversationId: 7,
        text: 'Contact support'
    }, { now: 1000, ttlMs: 5000 });

    assert.equal(consumePendingVerificationAction(client, 'order', { now: 2000 }), null);
    assert.equal(consumePendingVerificationAction(client, 'support', { now: 2000 })?.text, 'Contact support');
    assert.equal(consumePendingVerificationAction(client, 'support', { now: 2000 }), null);
});

test('expires and clears stale actions', () => {
    const client = {};
    rememberPendingVerificationAction(client, {
        purpose: 'order',
        conversationId: 9,
        text: 'Where is my order?'
    }, { now: 1000, ttlMs: 1000 });

    assert.equal(consumePendingVerificationAction(client, 'order', { now: 2001 }), null);
    assert.equal(client.pendingVerificationAction, null);
    clearPendingVerificationAction(client);
    assert.equal(client.pendingVerificationAction, null);
});
