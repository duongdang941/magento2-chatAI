import test from 'node:test';
import assert from 'node:assert/strict';

import { getGatewayRuntimeLimits } from '../services/gateway/runtime-limits.js';

test('bounds deployment runtime limits and derives the safe WebSocket image budget', () => {
    const limits = getGatewayRuntimeLimits({
        MAX_MESSAGES_PER_MINUTE: '999',
        MAX_WS_PAYLOAD_BYTES: String(1024 * 1024),
        MAX_CONCURRENT_MODEL_REQUESTS: '0'
    });

    assert.equal(limits.maxMessagesPerMinute, 120);
    assert.equal(limits.maxConcurrentModelRequests, 1);
    assert.equal(limits.maxWebSocketPayloadBytes, 1024 * 1024);
    assert.equal(limits.maxWebSocketEncodedImageBytes, 512 * 1024);
});
