import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayRuntime } from '../services/gateway-runtime.js';
import { guardWebSocketAction } from '../services/websocket-action-guard.js';

test('rate limits OTP requests by email even after the guest session rotates', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-ws-action' });
    await runtime.connect();
    const firstClient = { rateLimitKey: 'session:first', networkRateLimitKey: 'network:first' };
    const secondClient = { rateLimitKey: 'session:second', networkRateLimitKey: 'network:second' };

    for (let index = 0; index < 3; index += 1) {
        assert.equal(
            (await guardWebSocketAction(runtime, firstClient, 'guest_order_request_otp', {
                email: 'shopper@example.com'
            })).allowed,
            true
        );
    }
    assert.equal(
        (await guardWebSocketAction(runtime, secondClient, 'guest_order_request_otp', {
            email: 'shopper@example.com'
        })).allowed,
        false
    );
    assert.equal(
        (await guardWebSocketAction(runtime, secondClient, 'guest_order_request_otp', {
            email: 'another@example.com'
        })).allowed,
        true
    );
});

test('allows known chat and address actions and rejects unknown actions', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-ws-unmanaged' });
    await runtime.connect();
    const client = { rateLimitKey: 'customer:7' };

    assert.equal((await guardWebSocketAction(runtime, client, 'chat')).allowed, true);
    assert.equal((await guardWebSocketAction(runtime, client, 'order_address_update')).allowed, true);
    assert.deepEqual(
        await guardWebSocketAction(runtime, client, 'future_unreviewed_action'),
        { allowed: false, retryAfterMs: 0, reason: 'unknown_action' }
    );
});
