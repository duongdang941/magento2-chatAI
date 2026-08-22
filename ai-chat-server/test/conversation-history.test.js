import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationHistoryCodec } from '../services/conversation/conversation-history.js';

const codec = createConversationHistoryCodec({ maxModelHistoryMessages: 2 });

test('restores only bounded customer-visible guest history', () => {
    const restored = codec.guestHistoryMessagesFromClient([
        { role: 'user', content: 'old' },
        { role: 'user', content: 'find posters\n[CATALOG_CONTEXT:{"hidden":true}]' },
        {
            role: 'assistant',
            parts: [
                { type: 'text', raw: 'Here are posters.' },
                { type: 'image', url: 'http://afd.test/media/example.png', prompt: 'poster' },
                { type: 'guest_order_access', state: 'verified' }
            ]
        }
    ]);

    assert.equal(restored.length, 2);
    assert.equal(restored[0].content, 'find posters');
    assert.equal(restored[1].parts[1].type, 'image');
    assert.deepEqual(restored[1].parts[2], { type: 'guest_order_access', state: 'email', purpose: 'order' });
});

test('preserves safe support-agent metadata and support verification purpose', () => {
    const normalized = codec.normalizeStoredAssistantMessage({
        entity_id: 15,
        role: 'assistant',
        content: JSON.stringify({
            format: 'afd_ai_chat_message',
            text: 'We can help.',
            source: 'support_agent',
            sender_label: 'Support team',
            admin_id: 7,
            parts: [
                { type: 'text', raw: 'We can help.' },
                { type: 'guest_order_access', purpose: 'support' }
            ]
        })
    });

    assert.equal(normalized.source, 'support_agent');
    assert.equal(normalized.sender_label, 'Support team');
    assert.equal(normalized.parts[1].purpose, 'support');
    assert.equal('admin_id' in normalized, false);
});

test('normalizes stored structured responses without leaking internal text', () => {
    const normalized = codec.normalizeStoredAssistantMessage({
        entity_id: 9,
        role: 'assistant',
        content: JSON.stringify({
            format: 'afd_ai_chat_message',
            text: 'Visible answer',
            parts: [{ type: 'text', raw: 'Visible answer' }]
        })
    });

    assert.equal(normalized.content, 'Visible answer');
    assert.equal(normalized.parts[0].id, '9-0');
});

test('preserves safe message and feedback metadata required by the storefront', () => {
    const normalized = codec.normalizeStoredAssistantMessage({
        entity_id: 27,
        role: 'assistant',
        content: 'Answer',
        is_edited: true,
        edited_at: '2026-08-11 03:00:00',
        feedback: 'negative',
        feedback_reason: 'incorrect',
        feedback_comment: 'Wrong quantity',
        internal_secret: 'must-not-leak'
    });

    assert.equal(normalized.entity_id, 27);
    assert.equal(normalized.is_edited, true);
    assert.equal(normalized.feedback, 'negative');
    assert.equal(normalized.feedback_reason, 'incorrect');
    assert.equal(normalized.feedback_comment, 'Wrong quantity');
    assert.equal('internal_secret' in normalized, false);
});

test('serializes one canonical product presentation and generated image', () => {
    const stored = JSON.parse(codec.buildAssistantStoragePayload([
        { type: 'text', raw: 'Products:' },
        { type: 'products', payload: { items: [{ sku: 'old' }] }, html: '<div data-result="old"></div>' },
        { type: 'products', payload: { items: [{ sku: 'new' }] }, html: '<div data-result="new"></div>' },
        { type: 'image', url: 'http://afd.test/media/afd-ai/generated/image.png', prompt: 'image' }
    ]));

    assert.equal(stored.parts.filter((part) => part.type === 'products').length, 1);
    const productPart = stored.parts.find((part) => part.type === 'products');
    assert.equal(productPart.payload.items[0].sku, 'new');
    assert.equal(productPart.html, '<div data-result="new"></div>');
    assert.equal(stored.parts.find((part) => part.type === 'image').prompt, 'image');
});

test('restores a persisted product grid together with its payload', () => {
    const normalized = codec.normalizeStoredAssistantMessage({
        entity_id: 42,
        role: 'assistant',
        content: JSON.stringify({
            format: 'afd_ai_chat_message',
            text: 'Here are the products.',
            parts: [
                { type: 'text', raw: 'Here are the products.' },
                {
                    type: 'products',
                    html: '<div class="afd-ai-chat__product-grid"><img src="/media/product.jpg"></div>',
                    payload: { items: [{ id: 7, sku: 'SKU-7' }] }
                }
            ]
        })
    });

    const productPart = normalized.parts.find((part) => part.type === 'products');
    assert.equal(productPart.payload.items[0].sku, 'SKU-7');
    assert.match(productPart.html, /afd-ai-chat__product-grid/);
    assert.match(productPart.html, /product\.jpg/);
});

test('persists customer-safe tool activity for the completed-turn timeline', () => {
    const stored = JSON.parse(codec.buildAssistantStoragePayload([
        {
            type: 'reasoning',
            events: [
                { id: 'availability', type: 'activity', tool: 'getProductAvailability', state: 'completed', result_count: 1 },
                { id: 'step-1', type: 'step', content: 'Checking current availability.' }
            ]
        },
        { type: 'text', raw: 'There are 35 items available.' }
    ]));

    const reasoning = stored.parts.find((part) => part.type === 'reasoning');
    assert.equal(reasoning.events.length, 2);
    assert.deepEqual(reasoning.activities[0], {
        id: 'availability',
        type: 'activity',
        tool: 'getProductAvailability',
        state: 'completed',
        result_count: 1
    });

    const restored = codec.normalizeStoredAssistantMessage({
        entity_id: 43,
        role: 'assistant',
        content: JSON.stringify(stored)
    });
    assert.equal(restored.parts[0].type, 'reasoning');
    assert.equal(restored.parts[0].activities[0].tool, 'getProductAvailability');
});

test('allows the synced Admin limit to trim model history per request', () => {
    const codec = createConversationHistoryCodec({ maxModelHistoryMessages: 16 });
    const history = Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`
    }));

    const trimmed = codec.trimHistoryForModel(history, 4);

    assert.equal(trimmed.length, 4);
    assert.equal(trimmed[0].parts[0].text, 'message-4');
});

test('trims model history and builds compact titles', () => {
    const trimmed = codec.trimHistoryForModel([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' }
    ]);

    assert.deepEqual(trimmed.map((message) => message.parts[0].text), ['second', 'third']);
    assert.equal(codec.buildConversationTitle('Xin chào, giúp tôi tìm áo khoác?'), 'tìm áo khoác');
});

test('keeps only the latest catalogue memory outside the recent-turn budget', () => {
    const codec = createConversationHistoryCodec({ maxModelHistoryMessages: 16 });
    const history = codec.trimHistoryForModel([
        { role: 'assistant', content: 'First answer\n\n[CATALOG_CONTEXT:v2]\n{"products":[{"sku":"OLD"}]}' },
        { role: 'user', content: 'show something else' },
        { role: 'assistant', content: 'Second answer\n\n[CATALOG_CONTEXT:v2]\n{"products":[{"sku":"NEW"}]}' },
        { role: 'user', content: 'Is that one available?' }
    ], 4, 1024);

    assert.match(history[0].parts[0].text, /"sku":"NEW"/);
    assert.doesNotMatch(JSON.stringify(history), /"sku":"OLD"/);
    assert.equal((JSON.stringify(history).match(/CATALOG_CONTEXT/g) || []).length, 1);
    assert.match(JSON.stringify(history), /Second answer/);
});

test('reports history context reduction without changing stored history', () => {
    const codec = createConversationHistoryCodec({ maxModelHistoryMessages: 40 });
    const history = Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `message-${index} ${'detail '.repeat(400)}`
    }));
    let stats = null;

    codec.trimHistoryForModel(history, 20, 1024, (value) => { stats = value; });

    assert.equal(history.length, 20);
    assert.ok(stats.rawBytes > stats.modelBytes);
    assert.ok(stats.modelEstimatedTokens <= 1026);
});
