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
        utf8ByteLength: (value) => Buffer.byteLength(String(value || ''), 'utf8'),
        mergeProductGridHtml: (existing, incoming) => String(existing || '') + String(incoming || ''),
        mergeProductPayload: (existing, incoming) => ({ ...(existing || {}), ...(incoming || {}) }),
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

const connectionSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/connection.js', import.meta.url),
    'utf8'
);
const connectionSandbox = { window: { AfdAiChat: {} }, document: {} };
vm.runInNewContext(connectionSource, connectionSandbox);
const connectionMethods = connectionSandbox.window.AfdAiChat.connectionMethods({
    config: {},
    urls: {},
    helpers: {
        sanitizeHtml: value => String(value || ''),
        sanitizeCustomerResponseText: value => String(value || ''),
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

test('restores the visible branch and rehydrates when a replacement anchor is stale', () => {
    const originalMessages = [
        { entity_id: 11, role: 'user', content: 'Original question' },
        { entity_id: 12, role: 'assistant', content: 'Original answer' }
    ];
    const reloads = [];
    const context = {
        pendingBranchReplacement: {
            requestId: 'replace-1',
            conversationId: 9,
            anchorMessageId: 11,
            messages: originalMessages,
            hasStartedChat: true,
            messageFeedback: { 12: 'positive' },
            copiedMessageIndex: 1
        },
        messages: [{ role: 'user', content: 'Edited question', request_id: 'replace-1' }],
        hasStartedChat: true,
        messageFeedback: {},
        copiedMessageIndex: null,
        currentAiMessageIndex: 0,
        statusMessage: 'Thinking',
        isLoading: true,
        activeRequestId: 'replace-1',
        responseStartedAt: Date.now(),
        pendingProductParts: [{}],
        pendingOrderAddressFormParts: [{}],
        pendingGuestOrderAccessParts: [{}],
        clearResponseWatchdog: () => {},
        $nextTick: callback => callback(),
        switchConversation: (...args) => reloads.push(args)
    };

    assert.equal(methods.restoreFailedBranchReplacement.call(context, 'replace-1', true), true);
    assert.equal(context.messages, originalMessages);
    assert.equal(context.pendingBranchReplacement, null);
    assert.equal(context.activeRequestId, null);
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0][0], 9);
    assert.equal(reloads[0][1], true);
    assert.equal(reloads[0][2].replaceVisibleMessages, true);
});

test('does not render a service error card for a stale replacement anchor', () => {
    let restored = 0;
    const context = {
        shouldIgnoreStreamMessage: () => false,
        restoreFailedBranchReplacement: (requestId, reload) => {
            restored += 1;
            assert.equal(requestId, 'replace-1');
            assert.equal(reload, true);
            return true;
        }
    };

    methods.handleStreamMessage.call(context, {
        type: 'error',
        request_id: 'replace-1',
        error_code: 'REPLACE_ANCHOR_UNAVAILABLE'
    });

    assert.equal(restored, 1);
});

test('accepts pagination responses without a chat request id', () => {
    const context = {
        activeRequestId: null,
        cancelledRequestIds: {},
        isResponseLifecycleMessage: methods.isResponseLifecycleMessage
    };

    assert.equal(
        methods.shouldIgnoreStreamMessage.call(context, {
            type: 'products_page',
            product_part_id: 'product-part-1'
        }),
        false
    );
    assert.equal(
        methods.shouldIgnoreStreamMessage.call(context, {
            type: 'product_page_error',
            product_part_id: 'product-part-1'
        }),
        false
    );
});

test('uses the authoritative product total when a history adapter omits coverage', () => {
    const context = { productPageLoading: {} };
    assert.equal(
        methods.productResultsSummary.call(context, {
            payload: {
                total: 18,
                items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
                pagination: { page: 1, page_size: 5, total: 18, has_more: true, can_load_more: true },
                continuation: 'signed-token'
            }
        }),
        'Showing 5 of 18 matching products'
    );
});

test('uses storefront translations for product pagination UI', () => {
    const translations = {
        catalog_showing_page: '%1 von %2 passenden Produkten werden angezeigt',
        catalog_showing_all: 'Alle %1 Produkte werden angezeigt',
        catalog_show_more: 'Weitere %1 anzeigen',
        catalog_loading: 'Produkte werden geladen…'
    };
    const context = {
        productPageLoading: {},
        t(key, params = {}) {
            let value = translations[key] || key;
            Object.entries(params).forEach(([index, replacement]) => {
                value = value.replace(`%${index}`, String(replacement));
            });
            return value;
        },
        isProductPageLoading: methods.isProductPageLoading
    };
    const part = {
        id: 'product-part-1',
        payload: {
            total: 18,
            items: Array.from({ length: 5 }, (_, id) => ({ id: id + 1 })),
            pagination: { total: 18, page_size: 5, has_more: true, can_load_more: true },
            continuation: 'signed-token'
        }
    };

    assert.equal(methods.productResultsSummary.call(context, part), '5 von 18 passenden Produkten werden angezeigt');
    assert.equal(methods.productLoadMoreLabel.call(context, part), 'Weitere 5 anzeigen');
    context.productPageLoading = { 'product-part-1': true };
    assert.equal(methods.productLoadMoreLabel.call(context, part), 'Produkte werden geladen…');
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

test('does not replace an in-flight reasoning turn with a text-only refresh', () => {
    const liveReasoning = {
        type: 'reasoning',
        events: [{ id: 'step-1', type: 'step', content: 'Still thinking.' }],
        activities: [{ id: 'tool-1', type: 'activity', tool: 'searchProducts', state: 'running' }],
        isExpanded: true
    };
    const liveMessages = [
        { role: 'user', entity_id: 401, content: 'Find products', parts: [] },
        {
            role: 'assistant',
            entity_id: null,
            request_id: 'stream-1',
            parts: [liveReasoning, { type: 'text', raw: 'Working…' }]
        }
    ];
    const context = {
        activeConversationId: 9,
        activeRequestId: 'stream-1',
        currentAiMessageIndex: 1,
        messages: liveMessages,
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

    const result = historyMethods.applyConversationMessagePage.call(context, {
        status: 'success',
        refresh: true,
        conversationId: 9,
        messages: [
            { role: 'user', entity_id: 401, content: 'Find products', parts: [] },
            { role: 'assistant', entity_id: 402, content: 'Text-only durable snapshot.', parts: [{ type: 'text', raw: 'Text-only durable snapshot.' }] }
        ]
    }, false);

    assert.equal(result, false);
    assert.equal(context.messages[1].parts[0], liveReasoning);
    assert.equal(context.messages[1].parts[0].activities[0].state, 'running');
});

test('ignores a cross-tab snapshot while the current turn is streaming', () => {
    const liveReasoning = {
        type: 'reasoning',
        events: [{ id: 'step-1', type: 'step', content: 'Keep this text.' }],
        activities: [{ id: 'tool-1', type: 'activity', tool: 'searchProducts', state: 'running' }],
        isExpanded: true
    };
    const context = {
        isLoading: true,
        activeRequestId: 'stream-1',
        currentAiMessageIndex: 1,
        messages: [{ role: 'assistant', parts: [liveReasoning] }]
    };

    const result = connectionMethods.applyCrossTabMessageSnapshot.call(context, [
        { role: 'assistant', parts: [{ type: 'text', raw: 'Stale text-only snapshot.' }] }
    ], 9);

    assert.equal(result, true);
    assert.equal(context.messages[0].parts[0], liveReasoning);
    assert.equal(context.messages[0].parts[0].activities[0].state, 'running');
});

test('keeps the completed-turn duration in a guest snapshot after reload', () => {
    const context = {
        messages: [{
            role: 'assistant',
            workedForMs: 12_345,
            parts: [{
                type: 'reasoning',
                elapsedMs: 12_345,
                events: [{ id: 'catalog-search', type: 'activity', tool: 'searchProducts', state: 'completed' }],
                steps: [],
                activities: []
            }]
        }],
        serializeCrossTabPayload: value => value
    };

    const snapshot = connectionMethods.crossTabMessageSnapshot.call(context);
    assert.equal(snapshot[0].workedForMs, 12_345);
    assert.equal(snapshot[0].parts[0].elapsedMs, 12_345);
});

test('uses Magento history rather than a divergent cross-tab branch snapshot', () => {
    const switches = [];
    const context = {
        chatSyncTabId: 'tab-current',
        chatSyncScope: 'guest-scope',
        messages: [
            { entity_id: 101, role: 'user' },
            { entity_id: 102, role: 'assistant' }
        ],
        loadConversations: () => {},
        applyCrossTabMessageSnapshot: () => {
            throw new Error('A divergent snapshot must not overwrite durable ids.');
        },
        switchConversation: (...args) => switches.push(args)
    };

    connectionMethods.handleCrossTabEvent.call(context, {
        type: 'conversation_sync',
        source: 'tab-other',
        scope: 'guest-scope',
        conversationId: 9,
        messages: [
            { entity_id: 101, role: 'user' },
            { entity_id: 203, role: 'assistant' }
        ]
    });

    assert.equal(switches.length, 1);
    assert.equal(switches[0][0], 9);
    assert.equal(switches[0][1], true);
    assert.equal(switches[0][2].replaceVisibleMessages, true);
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
