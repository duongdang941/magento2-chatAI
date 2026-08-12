import test from 'node:test';
import assert from 'node:assert/strict';

import { GuestSessionHistory } from '../services/conversation/guest-session-history.js';

function createRuntime() {
    const records = new Map();
    return {
        async getGuestSessionHistory(key) {
            const value = records.get(key);
            return value ? JSON.parse(JSON.stringify(value)) : null;
        },
        async setGuestSessionHistory(key, value) {
            records.set(key, JSON.parse(JSON.stringify(value)));
        },
        async deleteGuestSessionHistory(key) {
            records.delete(key);
        }
    };
}

test('replaces only the obsolete guest history branch when a user message is edited', async () => {
    const history = new GuestSessionHistory(createRuntime());
    const guestId = 'a'.repeat(64);
    const conversation = await history.create(guestId, 'Order question');

    await history.append(guestId, conversation.id, { role: 'user', content: 'Keep this turn' });
    await history.append(guestId, conversation.id, { role: 'assistant', content: 'Keep this response' });
    await history.append(guestId, conversation.id, { role: 'user', content: 'Replace this turn' });
    await history.append(guestId, conversation.id, { role: 'assistant', content: 'Remove this response' });

    const before = await history.loadMessages(guestId, conversation.id);
    const branchStart = before.messages[2].entity_id;
    assert.equal(await history.truncateFromMessage(guestId, conversation.id, branchStart), true);

    const after = await history.loadMessages(guestId, conversation.id);
    assert.deepEqual(after.messages.map((message) => message.content), [
        'Keep this turn',
        'Keep this response'
    ]);
});

test('does not allow a temporary guest history branch to begin at an assistant response', async () => {
    const history = new GuestSessionHistory(createRuntime());
    const guestId = 'b'.repeat(64);
    const conversation = await history.create(guestId, 'Order question');

    await history.append(guestId, conversation.id, { role: 'user', content: 'Question' });
    await history.append(guestId, conversation.id, { role: 'assistant', content: 'Answer' });
    const page = await history.loadMessages(guestId, conversation.id);

    assert.equal(
        await history.truncateFromMessage(guestId, conversation.id, page.messages[1].entity_id),
        false
    );
    assert.equal((await history.loadMessages(guestId, conversation.id)).messages.length, 2);
});
