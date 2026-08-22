import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createLiveVoiceClientSecret,
    isLiveVoiceTool,
    liveVoiceToolDefinitions
} from '../services/media/live-voice-session.js';
import { handleLiveVoiceSession } from '../services/conversation/live-voice-handler.js';

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload)
    };
}

test('mints a browser-safe short-lived Realtime credential without returning the provider key', async () => {
    let request = null;
    const session = await createLiveVoiceClientSecret({
        config: {
            voice: {
                live: {
                    enabled: true,
                    api_key: 'sk-server-only',
                    model: 'gpt-realtime-1.5',
                    max_duration_seconds: 720
                }
            }
        },
        fetchImpl: async (url, options) => {
            request = { url, options };
            return response(200, { value: 'ek-short-lived', expires_at: 1234567890 });
        }
    });

    assert.equal(request.url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(request.options.headers.Authorization, 'Bearer sk-server-only');
    assert.equal(session.clientSecret, 'ek-short-lived');
    assert.equal(session.maximumDuration, 720);
    assert.equal(JSON.stringify(session).includes('sk-server-only'), false);
});

test('rejects disabled Live Voice before contacting OpenAI', async () => {
    let called = false;
    await assert.rejects(
        () => createLiveVoiceClientSecret({
            config: { voice: { live: { enabled: false } } },
            fetchImpl: async () => { called = true; return response(200, {}); }
        }),
        { code: 'VOICE_LIVE_DISABLED' }
    );
    assert.equal(called, false);
});

test('exposes only read-only Magento tools to a Live Voice session', () => {
    const names = liveVoiceToolDefinitions().map((tool) => tool.name).sort();
    assert.deepEqual(names, [
        'compareProducts',
        'getGuestOrderDetails',
        'getGuestOrders',
        'getOrderDetails',
        'getOrderFulfillment',
        'getProductAvailability',
        'getRecentOrders',
        'listCategories',
        'searchProducts',
        'searchStoreKnowledge'
    ]);
    assert.equal(isLiveVoiceTool('addToCart'), false);
    assert.equal(isLiveVoiceTool('cancelOrder'), false);
});

test('returns only an ephemeral Realtime credential through the customer WebSocket', async () => {
    const messages = [];
    const metrics = [];
    await handleLiveVoiceSession({
        ws: { send: value => messages.push(typeof value === 'string' ? JSON.parse(value) : value) },
        data: { request_id: 'live-1' },
        client: { rateLimitKey: 'guest:1', catalogScope: { storeCode: 'default' } },
        runtime: { consumeRateLimit: async () => ({ allowed: true }) },
        metrics: { increment: (...value) => metrics.push(value) },
        getConfig: async () => ({
            voice: {
                live: {
                    enabled: true,
                    api_key: 'sk-server-only',
                    model: 'gpt-realtime-1.5',
                    max_sessions_per_minute: 3,
                    max_duration_seconds: 600
                }
            }
        }),
        attachRequestId: payload => payload,
        createSession: async () => ({
            clientSecret: 'ek-short-lived',
            expiresAt: 1234567890,
            model: 'gpt-realtime-1.5',
            maximumDuration: 600
        })
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'live_voice_session');
    assert.equal(messages[0].client_secret, 'ek-short-lived');
    assert.equal(JSON.stringify(messages[0]).includes('sk-server-only'), false);
    assert.equal(metrics[0][0], 'live_voice_session_started');
});
