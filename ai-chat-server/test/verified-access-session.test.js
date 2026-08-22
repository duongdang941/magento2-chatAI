import test from 'node:test';
import assert from 'node:assert/strict';

import { createVerifiedAccessSession } from '../services/customer/verified-access-session.js';

function fixture() {
    const cache = new Map();
    const outbound = [];
    const runtime = {
        async getAuthCache(key) {
            return cache.get(key) || null;
        },
        async setAuthCache(key, value, ttlMs) {
            cache.set(key, { ...value, ttlMs });
        },
        async deleteAuthCache(key) {
            cache.delete(key);
        }
    };
    const session = createVerifiedAccessSession({
        runtime,
        getSupportConversationState: async () => ({ active: true, is_support: true, status: 'open' }),
        listSupportCases: async () => ({ status: 'success', cases: [] }),
        summarizeError: error => String(error?.message || ''),
        broadcastGuestSession: (origin, client, payload) => outbound.push(payload),
        isSocketOpen: () => true
    });

    return { cache, outbound, runtime, session };
}

test('bounds remembered guest-order access to 24 hours and restores it from shared cache', async () => {
    const { cache, session } = fixture();
    const now = Date.now();
    const client = { sessionId: 'session-1', customerId: null };

    assert.equal(await session.rememberGuestOrderAccess(
        client,
        ' SHOPPER@EXAMPLE.TEST ',
        'a'.repeat(64),
        999999,
        0
    ), true);
    assert.equal(client.guestOrderEmail, 'shopper@example.test');
    assert.ok(client.guestOrderAccessExpiresAt <= now + 24 * 60 * 60 * 1000 + 50);
    assert.ok(cache.has('guest-order-access:session-1'));

    const restored = { sessionId: 'session-1', customerId: null };
    assert.equal(await session.hydrateGuestOrderAccess(restored), true);
    assert.equal(restored.guestOrderAccessToken, 'a'.repeat(64));
});

test('clears invalid cached support identity before it reaches a protected request', async () => {
    const { cache, session } = fixture();
    cache.set('support-email-access:session-2', {
        email: 'shopper@example.test',
        accessToken: 'not-a-valid-token',
        expiresAt: Date.now() + 60_000
    });
    const client = { sessionId: 'session-2' };

    assert.equal(await session.hydrateSupportEmailVerification(client), false);
    assert.equal(cache.has('support-email-access:session-2'), false);
    assert.equal(session.supportPortalIdentity(client), null);
});

test('sends a customer-action result instead of querying support without verification', async () => {
    const { session } = fixture();
    const frames = [];
    await session.sendSupportPortal({ send: frame => frames.push(JSON.parse(frame)) }, { sessionId: 'session-3' }, 'form-1');

    assert.equal(frames.length, 1);
    assert.equal(frames[0].result.reason, 'guest_access_required');
    assert.deepEqual(frames[0].result.cases, []);
});

test('resets guest access locally and broadcasts the same unverified state', async () => {
    const { outbound, session } = fixture();
    const frames = [];
    const client = {
        sessionId: 'session-4',
        guestOrderEmail: 'shopper@example.test',
        guestOrderAccessToken: 'b'.repeat(64),
        guestOrderAccessExpiresAt: Date.now() + 60_000
    };
    await session.notifyGuestOrderAccessReset({ send: frame => frames.push(JSON.parse(frame)) }, client);

    assert.equal(client.guestOrderAccessToken, '');
    assert.equal(frames[0].state, 'email');
    assert.equal(outbound[0].state, 'email');
});
