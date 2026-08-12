import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createToolActivityId,
    emitToolActivity
} from '../services/orchestration/tool-activity.js';

test('emits a customer-safe running and completed tool timeline event', () => {
    const sent = [];
    const ws = { send: (message) => sent.push(JSON.parse(message)) };
    const activityId = createToolActivityId('catalog-1', 'searchProducts');

    emitToolActivity(ws, {
        activityId,
        toolName: 'searchProducts',
        state: 'running'
    });
    emitToolActivity(ws, {
        activityId,
        toolName: 'searchProducts',
        state: 'completed',
        result: { data: [{ id: 1 }, { id: 2 }] }
    });

    assert.deepEqual(sent, [
        {
            type: 'tool_activity',
            activity_id: 'tool-catalog-1',
            tool: 'searchProducts',
            state: 'running'
        },
        {
            type: 'tool_activity',
            activity_id: 'tool-catalog-1',
            tool: 'searchProducts',
            state: 'completed',
            result_count: 2
        }
    ]);
});

test('does not expose raw tool payloads in an activity event', () => {
    const sent = [];
    emitToolActivity({ send: (message) => sent.push(JSON.parse(message)) }, {
        activityId: 'tool-safe',
        toolName: 'getProductAvailability',
        state: 'failed',
        result: { error: 'internal endpoint https://example.test/?token=secret' }
    });

    assert.deepEqual(sent[0], {
        type: 'tool_activity',
        activity_id: 'tool-safe',
        tool: 'getProductAvailability',
        state: 'failed'
    });
});
