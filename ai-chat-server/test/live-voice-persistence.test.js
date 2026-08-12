import test from 'node:test';
import assert from 'node:assert/strict';

import { persistLiveVoiceTurn } from '../services/conversation/live-voice-persistence.js';

test('persists a Live Voice text turn without carrying audio data', async () => {
    const calls = [];
    const sent = [];
    const db = {
        getConversation: async () => ({ id: 7 }),
        createConversation: async () => 8,
        saveMessage: async (...args) => { calls.push(args); return calls.length + 20; },
        touchConversation: async (...args) => calls.push(['touch', ...args])
    };
    await persistLiveVoiceTurn({
        ws: { send: value => sent.push(typeof value === 'string' ? JSON.parse(value) : value) },
        data: {
            request_id: 'req-1',
            turn_id: 'turn-1',
            conversation_id: 7,
            user_text: '  What products are available? ',
            assistant_text: ' We have flags and posters. ',
            audio: 'this-must-not-be-stored'
        },
        client: { customerId: 12, rateLimitKey: 'customer:12', catalogScope: null },
        runtime: { claimOnce: async () => true },
        getConfig: async () => ({ persist_guest_history: true }),
        db,
        guestSessionHistory: null,
        attachRequestId: payload => payload
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(0, 4), [7, 12, 'user', 'What products are available?']);
    assert.equal(calls[1][2], 'assistant');
    assert.match(calls[1][3], /We have flags and posters\./);
    assert.doesNotMatch(JSON.stringify(calls), /this-must-not-be-stored/);
    assert.equal(sent[0].type, 'live_voice_saved');
});
