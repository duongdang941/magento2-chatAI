import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifyWebSocketTicket } from '../services/security/ws-ticket.js';

function encode(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(payload, secret) {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
}

function encryptCheckoutSessionId(sessionId, secret) {
    const nonce = crypto.randomBytes(12);
    const key = crypto
        .createHmac('sha256', secret)
        .update('afd-ai-websocket-ticket-session-v1', 'utf8')
        .digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('afd-ai-websocket', 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(sessionId, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

test('validates a short-lived Magento WebSocket ticket', () => {
    const secret = 'a'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        sub: '42',
        sid: 'session-hash',
        gid: 'a'.repeat(64),
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        jti: 'ticket-id',
        iat: now,
        exp: now + 60
    }, secret);

    const verified = verifyWebSocketTicket(ticket, secret);
    assert.equal(verified.expiresAt, (now + 60) * 1000);
    assert.deepEqual({ ...verified, expiresAt: undefined }, {
        customerId: 42,
        sessionId: 'session-hash',
        guestHistoryId: 'a'.repeat(64),
        sessionCookie: 'PHPSESSID=checkout-session-id',
        ticketId: 'ticket-id',
        role: 'customer',
        source: 'ticket',
        expiresAt: undefined
    });
});

test('uses the signed durable guest identity when present', () => {
    const secret = 'g'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const guestHistoryId = 'f'.repeat(64);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        sid: 'checkout-session-hash',
        gid: guestHistoryId,
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        jti: 'guest-history-ticket',
        iat: now,
        exp: now + 60
    }, secret);

    const verified = verifyWebSocketTicket(ticket, secret);
    assert.equal(verified.sessionId, 'checkout-session-hash');
    assert.equal(verified.guestHistoryId, guestHistoryId);
});

test('rejects a guest ticket without the Magento-issued chat identity', () => {
    const secret = 'h'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        sid: 'session-hash',
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        jti: 'guest-ticket-without-gid',
        iat: now,
        exp: now + 60
    }, secret);

    assert.throws(() => verifyWebSocketTicket(ticket, secret), /guest chat identity/i);
});

test('preserves the signed Magento store and customer group scope', () => {
    const secret = 'd'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        sub: '42',
        sid: 'session-hash',
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        catalog_scope: {
            store_id: 2,
            store_code: 'parteimitglied_de',
            website_id: 1,
            customer_group_id: 3
        },
        jti: 'ticket-id',
        iat: now,
        exp: now + 60
    }, secret);

    assert.deepEqual(verifyWebSocketTicket(ticket, secret).catalogScope, {
        storeCode: 'parteimitglied_de',
        customerGroupId: 3
    });
});

test('preserves the signed Magento installation tenant on the catalogue scope', () => {
    const secret = 't'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const tenantId = 'a'.repeat(64);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        sid: 'session-hash',
        gid: 'c'.repeat(64),
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        tenant_id: tenantId,
        catalog_scope: { store_code: 'default', customer_group_id: 0 },
        jti: 'tenant-ticket-id',
        iat: now,
        exp: now + 60
    }, secret);

    const verified = verifyWebSocketTicket(ticket, secret);
    assert.equal(verified.tenantId, tenantId);
    assert.equal(verified.catalogScope.tenantId, tenantId);
});

test('validates a support administrator WebSocket ticket without a checkout session', () => {
    const secret = 'c'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const ticket = sign({
        aud: 'afd-ai-websocket',
        role: 'support_admin',
        aid: 17,
        name: 'Store Admin',
        sid: 'admin-session-hash',
        jti: 'admin-ticket-id',
        iat: now,
        exp: now + 60
    }, secret);

    const verified = verifyWebSocketTicket(ticket, secret);
    assert.equal(verified.expiresAt, (now + 60) * 1000);
    assert.deepEqual({ ...verified, expiresAt: undefined }, {
        adminId: 17,
        adminName: 'Store Admin',
        customerId: null,
        sessionId: 'admin-session-hash',
        sessionCookie: '',
        ticketId: 'admin-ticket-id',
        role: 'support_admin',
        source: 'ticket',
        expiresAt: undefined
    });
});

test('rejects expired and modified tickets', () => {
    const secret = 'b'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const expired = sign({
        aud: 'afd-ai-websocket',
        sid: 'session-hash',
        sct: encryptCheckoutSessionId('checkout-session-id', secret),
        scn: 'PHPSESSID',
        jti: 'ticket-id',
        iat: now - 120,
        exp: now - 1
    }, secret);

    assert.throws(() => verifyWebSocketTicket(expired, secret), /expired|invalid/i);
    assert.throws(() => verifyWebSocketTicket(`${expired}x`, secret), /signature|malformed/i);
});
