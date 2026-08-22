import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuestHistorySync } from '../services/conversation/guest-history-sync.js';

function createFixture() {
    const origin = { readyState: 1, OPEN: 1, sent: [] };
    const matching = { readyState: 1, OPEN: 1, sent: [], send(frame) { this.sent.push(JSON.parse(frame)); } };
    const other = { readyState: 1, OPEN: 1, sent: [], send(frame) { this.sent.push(JSON.parse(frame)); } };
    const clientData = new Map([
        [origin, { guestHistoryId: 'guest-a' }],
        [matching, { guestHistoryId: 'guest-a' }],
        [other, { guestHistoryId: 'guest-b' }]
    ]);
    const appended = [];
    const sync = createGuestHistorySync({
        wss: { clients: new Set([origin, matching, other]) },
        clientData,
        isSocketOpen: socket => socket.readyState === socket.OPEN,
        guestSessionHistory: {
            append: async (...args) => appended.push(args),
            loadMessages: async () => ({ messages: [{ role: 'assistant', content: 'session' }] })
        },
        loadGuestMessages: async () => ({ messages: [{ role: 'assistant', content: 'database' }] }),
        getPrepareHistoryMessages: () => async messages => messages,
        extractTextFromParts: parts => parts.map(part => part.raw || '').join(''),
        guestHistoryMessagesFromClient: history => history,
        summarizeError: error => String(error?.message || '')
    });

    return { appended, matching, origin, other, sync };
}

test('builds one attachment reference payload without copying image bytes', () => {
    const { sync } = createFixture();
    const currentUser = {
        text: 'Inspect this image',
        parts: [{ type: 'attachment_ref', attachment_id: 'attachment-1', mime_type: 'image/png', size: 123 }]
    };
    const payload = JSON.parse(sync.buildUserMessageAttachmentPayload(currentUser, {
        images: [{ name: 'product.png', type: 'image/png', size: 123 }]
    }));

    assert.equal(payload.attachments[0].attachment_id, 'attachment-1');
    assert.equal(payload.attachments[0].name, 'product.png');
    assert.equal(Object.hasOwn(payload.attachments[0], 'data'), false);
});

test('broadcasts guest history only to another tab with the same signed identity', async () => {
    const { matching, origin, other, sync } = createFixture();
    await sync.broadcastGuestConversation(origin, { guestHistoryId: 'guest-a' }, 'database', 21);

    assert.equal(matching.sent.length, 1);
    assert.equal(matching.sent[0].conversation_id, 21);
    assert.equal(matching.sent[0].messages[0].content, 'database');
    assert.equal(other.sent.length, 0);
});

test('restores only history messages accepted by the bounded codec', async () => {
    const { appended, sync } = createFixture();
    await sync.restoreGuestHistoryFromClient([{ role: 'user', content: 'hello' }], 'guest-a', 7);

    assert.deepEqual(appended, [['guest-a', 7, { role: 'user', content: 'hello' }]]);
});
