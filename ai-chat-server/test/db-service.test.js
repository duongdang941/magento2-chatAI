import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationExists, normalizeConversationPage } from '../services/db-service.js';

test('conversationExists returns true only for matching conversation ids', () => {
    const conversations = [
        { id: 11, title: 'First' },
        { id: '22', title: 'Second' }
    ];

    assert.equal(conversationExists(conversations, 11), true);
    assert.equal(conversationExists(conversations, '22'), true);
    assert.equal(conversationExists(conversations, 33), false);
    assert.equal(conversationExists([], 11), false);
    assert.equal(conversationExists(null, 11), false);
});

test('normalizeConversationPage accepts Magento pagination tuples', () => {
    const page = normalizeConversationPage([
        [{ id: 40, title: 'Newest' }, { id: 39, title: 'Older' }],
        true,
        3
    ], 2);

    assert.equal(page.conversations.length, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextPage, 3);
    assert.equal(page.page, 2);
});

test('normalizeConversationPage remains compatible with the legacy list response', () => {
    const page = normalizeConversationPage([{ id: 40, title: 'Existing history' }], 1);

    assert.deepEqual(page.conversations, [{ id: 40, title: 'Existing history' }]);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextPage, null);
    assert.equal(page.page, 1);
});
