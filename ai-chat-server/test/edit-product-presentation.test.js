import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const streamSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream.js', import.meta.url),
    'utf8'
);
const sandbox = { window: { AfdAiChat: {} }, document: {} };
vm.runInNewContext(streamSource, sandbox);

const methods = sandbox.window.AfdAiChat.streamMethods({
    config: {},
    urls: {},
    helpers: {
        hydrateProductGridHtml: (html) => html,
        MAX_WEBSOCKET_PAYLOAD_BYTES: 128
    }
});

const historySource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/history.js', import.meta.url),
    'utf8'
);
const historySandbox = { window: { AfdAiChat: {} } };
vm.runInNewContext(historySource, historySandbox);
const historyMethods = historySandbox.window.AfdAiChat.historyMethods({
    config: {},
    urls: {},
    helpers: {
        sanitizeHtml: value => String(value || ''),
        hydrateProductGridHtml: value => String(value || '')
    }
});

test('editing a customer turn stops an active response before opening the editor', () => {
    let stopped = 0;
    const context = {
        isLoading: true,
        isReadingAttachments: false,
        messages: [{ role: 'user', content: 'Find a jacket', attachments: [], mutationBusy: false }],
        editingMessageIndex: null,
        editingMessageDraft: '',
        editingMessageAttachments: [],
        messageFeedback: {},
        copiedMessageIndex: null,
        stopCurrentResponse() {
            stopped += 1;
            this.isLoading = false;
        },
        copyMessageAttachments: () => [],
        resizeEditMessageInput: () => {},
        getEditMessageInput: () => null,
        $nextTick: (callback) => callback()
    };

    methods.editMessage.call(context, 0);

    assert.equal(stopped, 1);
    assert.equal(context.editingMessageIndex, 0);
    assert.equal(context.editingMessageDraft, 'Find a jacket');
});

test('keeps one product grid in the current assistant turn when the gateway publishes a replacement', () => {
    const context = {
        activeRequestId: 'request-1',
        cancelledRequestIds: {},
        currentAiMessageIndex: 0,
        messages: [{
            role: 'assistant',
            request_id: 'request-1',
            parts: [{ type: 'text', raw: 'Here are the matching products.' }]
        }],
        pendingProductParts: [],
        toolActivities: [],
        statusMessage: '',
        isLoading: true,
        shouldIgnoreStreamMessage: () => false,
        armResponseWatchdog: () => {},
        toolActivityLabel: () => 'Searching products',
        flushPendingProductParts: methods.flushPendingProductParts,
        scheduleGuestSessionSnapshot: () => {},
        scrollToBottom: () => {},
        $nextTick: (callback) => callback()
    };

    methods.handleStreamMessage.call(context, {
        type: 'products_html',
        request_id: 'request-1',
        html: '<div class="afd-ai-chat__product-grid" data-result="first"></div>',
        products: { items: [{ id: 1 }] }
    });

    assert.equal(context.pendingProductParts.length, 1);
    assert.equal(context.messages[0].parts.some(part => part.type === 'products'), false);

    methods.handleStreamMessage.call(context, {
        type: 'tool_activity',
        request_id: 'request-1',
        activity_id: 'catalog-2',
        tool: 'searchProducts',
        state: 'running'
    });
    assert.equal(context.currentAiMessageIndex, 0);

    methods.handleStreamMessage.call(context, {
        type: 'products_html',
        request_id: 'request-1',
        html: '<div class="afd-ai-chat__product-grid" data-result="final"></div>',
        products: { items: [{ id: 2 }], pagination: { can_load_more: true } }
    });

    assert.equal(context.pendingProductParts.length, 1);
    assert.equal(context.messages[0].parts.some(part => part.type === 'products'), false);
    methods.flushPendingProductParts.call(context);
    const productParts = context.messages[0].parts.filter(part => part.type === 'products');
    assert.equal(productParts.length, 1);
    assert.equal(productParts[0].html.includes('data-result="final"'), true);
    assert.deepEqual(productParts[0].payload.items, [{ id: 2 }]);
});

test('queues custom guest-access HTML until the final assistant text is complete', () => {
    const appended = [];
    const context = {
        activeRequestId: 'request-2',
        cancelledRequestIds: {},
        currentAiMessageIndex: 0,
        messages: [{
            role: 'assistant',
            request_id: 'request-2',
            parts: [{ type: 'text', raw: 'Please verify your email.' }]
        }],
        pendingProductParts: [],
        pendingOrderAddressFormParts: [],
        pendingGuestOrderAccessParts: [],
        toolActivities: [],
        isLoading: true,
        shouldIgnoreStreamMessage: () => false,
        armResponseWatchdog: () => {},
        appendGuestOrderAccessForm: data => appended.push(data),
        scheduleGuestSessionSnapshot: () => {},
        scrollToBottom: () => {},
        $nextTick: callback => callback()
    };

    methods.handleStreamMessage.call(context, {
        type: 'guest_order_access_required',
        request_id: 'request-2',
        purpose: 'support',
        content: 'Verify your email before starting human support.'
    });

    assert.equal(appended.length, 0);
    assert.equal(context.pendingGuestOrderAccessParts.length, 1);

    methods.flushPendingGuestOrderAccessParts.call(context);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].content, '');
});

test('rejects a serialized chat frame that exceeds the WebSocket budget', async () => {
    const sent = [];
    const context = {
        userInput: 'large request',
        imageAttachments: [],
        uploadError: '',
        isLoading: false,
        isReadingAttachments: false,
        humanSupportActive: false,
        messages: [],
        activeConversationId: 0,
        isLoggedIn: false,
        cancelledRequestIds: {},
        pendingProductParts: [],
        pendingOrderAddressFormParts: [],
        pendingGuestOrderAccessParts: [],
        toolActivities: [],
        socket: { send: payload => sent.push(payload) },
        wsConnected: true,
        validateOutgoingAttachmentBudget: () => true,
        stopSupportTyping: () => {},
        resetComposerInput: () => {},
        createRequestId: () => 'frame-too-large',
        scheduleGuestSessionSnapshot: () => {},
        armResponseWatchdog: () => {},
        scrollToBottom: () => {},
        buildOutgoingUserParts: text => [{ text }],
        buildModelHistory: () => [{ role: 'model', parts: [{ text: 'x'.repeat(500) }] }],
        buildGuestHistorySnapshot: () => [{ role: 'assistant', parts: [{ type: 'text', raw: 'g'.repeat(500) }] }],
        scheduleCrossTabConversationSync: () => {},
        clearResponseWatchdog: () => {},
        resizeComposerInput: () => {},
        $nextTick: callback => callback()
    };

    await methods.sendMessagePayload.call(context, 'large request', [], 'large request', true);

    assert.equal(sent.length, 0);
    assert.equal(context.messages.length, 0);
    assert.match(context.uploadError, /too large for the secure chat connection/i);
});

test('replaces an anonymous guest snapshot turn with its durable history record', () => {
    const product = {
        type: 'products',
        html: '<div class="afd-ai-chat__product-grid"></div>',
        payload: { product_ids: [1, 2], items: [{ id: 1 }, { id: 2 }] }
    };
    const transientMessages = [
        { role: 'user', entity_id: null, content: 'Show available products', parts: [] },
        {
            role: 'assistant',
            entity_id: null,
            content: '',
            parts: [{ type: 'text', raw: 'Here are the available products.' }, product]
        }
    ];
    const context = {
        activeConversationId: 9,
        activeHistoryLoadToken: '',
        messages: transientMessages,
        isLoadingOlderMessages: false,
        hasOlderMessages: false,
        nextMessageCursor: null,
        isHistoryLoading: true,
        hasStartedChat: true,
        isCurrentConversationResponse: () => true,
        normalizeLoadedMessage: message => message,
        enforceSingleActiveOrderAddressForm: () => {},
        scheduleGuestSessionSnapshot: () => {},
        scrollToBottom: () => {},
        $nextTick: callback => callback()
    };
    const durableMessages = [
        { ...transientMessages[0], entity_id: 301 },
        { ...transientMessages[1], entity_id: 302, content: 'Here are the available products.' }
    ];

    historyMethods.applyConversationMessagePage.call(context, {
        status: 'success',
        refresh: true,
        conversationId: 9,
        messages: durableMessages
    }, false);

    assert.equal(context.messages.length, 2);
    assert.deepEqual(context.messages.map(message => message.entity_id), [301, 302]);
    assert.equal(context.messages[1].parts.filter(part => part.type === 'products').length, 1);
});

test('removes stale and persisted duplicates while refreshing guest product history', () => {
    const product = {
        type: 'products',
        html: '<div class="afd-ai-chat__product-grid"></div>',
        payload: { product_ids: [1, 2], items: [{ id: 1 }, { id: 2 }] }
    };
    const user = { role: 'user', content: 'Show available products', parts: [] };
    const assistant = {
        role: 'assistant',
        content: '',
        parts: [{ type: 'text', raw: 'Here are the available products.' }, product]
    };
    const context = {
        activeConversationId: 9,
        activeHistoryLoadToken: '',
        messages: [
            { ...user, entity_id: null },
            { ...assistant, entity_id: null },
            { ...user, entity_id: 301 },
            { ...assistant, entity_id: 302, content: 'Here are the available products.' }
        ],
        isLoadingOlderMessages: false,
        hasOlderMessages: false,
        nextMessageCursor: null,
        isHistoryLoading: true,
        hasStartedChat: true,
        isCurrentConversationResponse: () => true,
        normalizeLoadedMessage: message => message,
        enforceSingleActiveOrderAddressForm: () => {},
        scheduleGuestSessionSnapshot: () => {},
        scrollToBottom: () => {},
        $nextTick: callback => callback()
    };

    historyMethods.applyConversationMessagePage.call(context, {
        status: 'success',
        refresh: true,
        conversationId: 9,
        messages: [
            { ...user, entity_id: 301 },
            { ...assistant, entity_id: 302, content: 'Here are the available products.' }
        ]
    }, false);

    assert.equal(context.messages.length, 2);
    assert.deepEqual(context.messages.map(message => message.entity_id), [301, 302]);
    assert.equal(context.messages[1].parts.filter(part => part.type === 'products').length, 1);
});
