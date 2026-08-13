import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { registerGatewayHttpRoutes, verifyConfigPush } from '../services/gateway/gateway-http-routes.js';

function signedRequest(body, secret, timestamp = Math.floor(Date.now() / 1000).toString(), path = '/internal/config') {
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.POST.${path}.${body}`, 'utf8')
        .digest('hex');
    const headers = {
        'X-Afd-AI-Timestamp': timestamp,
        'X-Afd-AI-Signature': signature
    };

    return {
        rawBody: body,
        method: 'POST',
        originalUrl: path,
        get(name) {
            return headers[name] || '';
        }
    };
}

test('accepts only a fresh configuration signature bound to method, path and raw body', () => {
    const secret = 's'.repeat(32);
    const request = signedRequest('{"version":1}', secret);

    assert.equal(verifyConfigPush(request, secret), true);
    assert.equal(verifyConfigPush({ ...request, rawBody: '{"version":2}' }, secret), false);
    assert.equal(verifyConfigPush({ ...request, originalUrl: '/internal/session-revoke' }, secret), false);
    assert.equal(verifyConfigPush({ ...request, method: 'PUT' }, secret), false);
    assert.equal(
        verifyConfigPush(signedRequest('{}', secret, '1'), secret),
        false
    );

    const proxiedRequest = signedRequest('{"version":1}', secret, undefined, '/internal/config');
    proxiedRequest.originalUrl = '/ai-gateway/internal/config';
    assert.equal(verifyConfigPush(proxiedRequest, secret), true);
});

test('health route exposes only status and caches the Magento probe', async () => {
    const routes = new Map();
    const app = {
        use() {},
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); }
    };
    let probeCount = 0;
    registerGatewayHttpRoutes({
        app,
        runtime: { getHealth: () => ({ connected: true }) },
        metrics: { toPrometheus: async () => '' },
        db: { pingMagento: async () => { probeCount += 1; return true; } },
        websocketConnections: () => 9,
        metricsToken: '',
        syncSecret: 's'.repeat(32)
    });

    const responses = [];
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(payload) { responses.push({ statusCode: this.statusCode, payload }); }
    };
    const health = routes.get('GET /health');
    await health({}, response);
    await health({}, response);

    const proxiedHealth = routes.get('GET /ai-gateway/health');
    assert.equal(typeof proxiedHealth, 'function');

    assert.deepEqual(responses, [
        { statusCode: 200, payload: { status: 'ok' } },
        { statusCode: 200, payload: { status: 'ok' } }
    ]);
    assert.equal(probeCount, 1);
});

test('support notification is signed, replay protected, and broadcasts only normalized identity data', async () => {
    const routes = new Map();
    const claimed = new Set();
    const broadcasts = [];
    const app = {
        use() {},
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); }
    };
    registerGatewayHttpRoutes({
        app,
        runtime: {
            getHealth: () => ({ connected: true }),
            claimOnce: async (namespace, key) => {
                const id = `${namespace}:${key}`;
                if (claimed.has(id)) return false;
                claimed.add(id);
                return true;
            }
        },
        metrics: { toPrometheus: async () => '' },
        db: { pingMagento: async () => true },
        websocketConnections: () => 0,
        syncSecret: 's'.repeat(32),
        broadcastSupportMessage(payload) { broadcasts.push(payload); return 1; }
    });

    const payload = {
        version: 1,
        event_id: 'a'.repeat(32),
        conversation_id: 19,
        customer_id: 0,
        guest_id: 'b'.repeat(64),
        message_id: 41
    };
    const body = JSON.stringify(payload);
    const request = Object.assign(signedRequest(body, 's'.repeat(32), undefined, '/internal/support-message'), { body: payload });
    const responses = [];
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(value) { responses.push({ statusCode: this.statusCode || 200, value }); }
    };
    const route = routes.get('POST /internal/support-message');
    await route(request, response);
    await route(request, response);

    assert.deepEqual(broadcasts, [{ conversationId: 19, customerId: 0, guestId: 'b'.repeat(64), messageId: 41 }]);
    assert.equal(responses[0].value.recipients, 1);
    assert.equal(responses[1].statusCode, 409);
});

test('support mode notification broadcasts only a bounded agent label', async () => {
    const routes = new Map();
    const broadcasts = [];
    const app = {
        use() {},
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); }
    };
    registerGatewayHttpRoutes({
        app,
        runtime: { getHealth: () => ({ connected: true }), claimOnce: async () => true },
        metrics: { toPrometheus: async () => '' },
        db: { pingMagento: async () => true },
        websocketConnections: () => 0,
        syncSecret: 's'.repeat(32),
        broadcastSupportMode(payload) { broadcasts.push(payload); return 2; }
    });
    const payload = {
        version: 1,
        event_id: 'c'.repeat(32),
        conversation_id: 19,
        customer_id: 8,
        guest_id: '',
        active: true,
        agent_label: 'A'.repeat(120)
    };
    const body = JSON.stringify(payload);
    const request = Object.assign(signedRequest(body, 's'.repeat(32), undefined, '/internal/support-mode'), { body: payload });
    let responsePayload;
    await routes.get('POST /internal/support-mode')(request, {
        status() { return this; },
        json(value) { responsePayload = value; }
    });

    assert.equal(responsePayload.recipients, 2);
    assert.equal(broadcasts[0].agentLabel.length, 80);
    assert.equal(broadcasts[0].active, true);
});

test('support message mutation is signed, replay protected, and broadcasts bounded public state', async () => {
    const routes = new Map();
    const claimed = new Set();
    const broadcasts = [];
    const app = {
        use() {},
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); }
    };
    registerGatewayHttpRoutes({
        app,
        runtime: {
            getHealth: () => ({ connected: true }),
            claimOnce: async (namespace, key) => {
                const id = `${namespace}:${key}`;
                if (claimed.has(id)) return false;
                claimed.add(id);
                return true;
            }
        },
        metrics: { toPrometheus: async () => '' },
        db: { pingMagento: async () => true },
        websocketConnections: () => 0,
        syncSecret: 's'.repeat(32),
        broadcastSupportMutation(payload) { broadcasts.push(payload); return 2; }
    });
    const payload = {
        version: 1,
        event_id: 'd'.repeat(32),
        conversation_id: 23,
        customer_id: 7,
        guest_id: '',
        message_id: 99,
        operation: 'edit',
        content: 'x'.repeat(5000),
        edited_at: '2026-08-10 10:00:00',
        deleted_at: ''
    };
    const body = JSON.stringify(payload);
    const request = Object.assign(
        signedRequest(body, 's'.repeat(32), undefined, '/internal/support-message-mutation'),
        { body: payload }
    );
    const responses = [];
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(value) { responses.push({ statusCode: this.statusCode || 200, value }); }
    };
    const route = routes.get('POST /internal/support-message-mutation');
    await route(request, response);
    await route(request, response);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].content.length, 4000);
    assert.equal(broadcasts[0].operation, 'edit');
    assert.equal(responses[0].value.recipients, 2);
    assert.equal(responses[1].statusCode, 409);
});
