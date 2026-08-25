import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildInterruptedAssistantPayload,
    interruptedResponseMetadata
} from '../services/conversation/interrupted-response.js';

test('interrupted assistant payload retains only text already streamed to the shopper', () => {
    const payload = buildInterruptedAssistantPayload([
        { type: 'text', raw: 'Phần trả lời đang hiển thị.' },
        { type: 'products', payload: { items: [{ sku: 'JACKET-01' }] } },
        { type: 'text', raw: 'Phần tiếp theo đã được stream.' }
    ], 2_400, 5_050);

    assert.deepEqual(payload.parts, [
        { type: 'text', raw: 'Phần trả lời đang hiển thị.' },
        { type: 'text', raw: 'Phần tiếp theo đã được stream.' }
    ]);
    assert.equal(payload.interrupted, true);
    assert.equal(payload.stopped_after_seconds, 2);
});

test('interrupted response duration is never negative', () => {
    assert.deepEqual(interruptedResponseMetadata(8_000, 7_100), {
        interrupted: true,
        stopped_after_seconds: 0
    });
});

test('marks a reload interruption without changing an explicit stop payload', () => {
    assert.deepEqual(interruptedResponseMetadata(1_000, 3_100, 'connection_lost'), {
        interrupted: true,
        stopped_after_seconds: 2,
        interruption_reason: 'connection_lost'
    });
    assert.deepEqual(interruptedResponseMetadata(1_000, 3_100, 'user_stop'), {
        interrupted: true,
        stopped_after_seconds: 2
    });
});
