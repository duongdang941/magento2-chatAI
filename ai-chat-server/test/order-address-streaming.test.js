import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const streamSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream.js', import.meta.url),
    'utf8'
);
const orderAddressSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/order-address-stream.js', import.meta.url), 'utf8');
const streamRendererSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream-renderer.js', import.meta.url),
    'utf8'
);
const shellSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/shell.js', import.meta.url),
    'utf8'
);
const conversationTemplate = fs.readFileSync(
    new URL('../../view/frontend/templates/chat/partials/conversation.phtml', import.meta.url),
    'utf8'
);

function createChat() {
    const browserWindow = {
        AfdAiChat: {},
        setTimeout() { return 0; },
        clearTimeout() {},
        setInterval() { return 1; },
        clearInterval() {}
    };
    const context = {
        window: browserWindow,
        document: {
            getElementById() { return null; }
        },
        Date,
        Math,
        Set,
        Number,
        String,
        Array,
        Object,
        ResizeObserver: undefined
    };
    vm.runInNewContext(streamRendererSource, context);
    vm.runInNewContext(streamSource, context); vm.runInNewContext(orderAddressSource, context); vm.runInNewContext(shellSource, context);
    const moduleContext = {
        config: {},
        urls: {},
        helpers: {
            sanitizeHtml: (value) => String(value || ''),
            sanitizeStreamingHtml: (value) => String(value || ''),
            sanitizeStreamingHtmlBlocks: (value) => [String(value || '')],
            splitHtmlBlocks: (value) => String(value || '') ? [String(value)] : [],
            hydrateProductGridHtml: (value) => String(value || '')
        }
    };
    const rendererMethods = browserWindow.AfdAiChat.streamRendererMethods(moduleContext);
    const methods = browserWindow.AfdAiChat.streamMethods(moduleContext);
    const orderAddressMethods = browserWindow.AfdAiChat.orderAddressStreamMethods(moduleContext);
    const shellMethods = browserWindow.AfdAiChat.shellMethods(moduleContext);

    return {
        ...rendererMethods,
        ...methods,
        ...orderAddressMethods,
        ...shellMethods,
        messages: [],
        currentAiMessageIndex: -1,
        pendingProductParts: [],
        pendingOrderAddressFormParts: [],
        pendingGuestOrderAccessParts: [],
        toolActivities: [],
        cancelledRequestIds: {},
        activeRequestId: 'stream-1',
        activeConversationId: 1,
        isLoading: true,
        statusMessage: '',
        responseStartedAt: Date.now(),
        $nextTick(callback) { callback(); },
        scheduleGuestSessionSnapshot() {},
        scheduleCrossTabConversationSync() {},
        scrollToBottom() {},
        t(key) { return key; },
        toolActivityLabel(activity) { return String(activity?.tool || ''); },
        clearResponseWatchdog() {},
        armResponseWatchdog() {}
    };
}

test('queues the address form until the final customer-facing stream text is complete', () => {
    const chat = createChat();
    const form = {
        type: 'order_address_form',
        request_id: 'stream-1',
        form_id: 'address-form-1',
        action_token: 'signed-form-token',
        created_at: Date.now(),
        expires_at: Date.now() + 60_000,
        order_number: '000001001',
        address_types: ['shipping'],
        address_type: 'shipping',
        addresses: { shipping: { firstname: 'Ada', country_id: 'DE' } },
        fields: [{ code: 'firstname', label: 'First name', required: true }],
        countries: [{ value: 'DE', label: 'Germany' }],
        regions: {}
    };

    chat.handleStreamMessage(form);
    assert.equal(chat.messages.length, 0);
    assert.equal(chat.pendingOrderAddressFormParts.length, 1);

    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Your order can be updated.' });
    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.deepEqual(
        Array.from(chat.messages[0].parts, (part) => part.type),
        ['text', 'order_address_form']
    );
    assert.equal(chat.messages[0].parts[1].address.country_id, 'DE');
    assert.equal(chat.messages[0].parts[1].actionToken, 'signed-form-token');
    assert.equal(chat.pendingOrderAddressFormParts.length, 0);
});

test('shows the provider reasoning text before the first tool activity', () => {
    const chat = createChat();
    chat.thinkingEvents = [];
    chat.thinkingSteps = [];

    chat.handleStreamMessage({
        type: 'thinking_step',
        request_id: 'stream-1',
        step_id: 'draft',
        content: 'Drafting Vietnamese text',
        visibility: 'public'
    });

    assert.equal(chat.currentAiMessageIndex, 0);
    assert.equal(chat.messages.length, 1);
    assert.deepEqual(
        Array.from(chat.reasoningSteps(chat.messages[0].parts[0]), step => [step.source, step.content, step.state]),
        [['provider_reasoning', 'Drafting Vietnamese text', 'running']]
    );

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Still composing.' });
    assert.deepEqual(
        Array.from(chat.messages[0].parts, part => part.type),
        ['reasoning', 'text']
    );
    assert.equal(chat.messages[0].parts[0].isExpanded, false);
    const reasoningId = chat.messages[0].parts[0].id;
    assert.deepEqual(
        Array.from(chat.reasoningSteps(chat.messages[0].parts[0]), step => [step.source, step.content, step.state]),
        [['provider_reasoning', 'Drafting Vietnamese text', 'running']]
    );

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'completed',
        result_count: 2
    });
    assert.equal(chat.messages[0].parts[0].isExpanded, true);

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });
    assert.equal(chat.messages[0].parts[0].id, reasoningId);
    assert.equal(chat.messages[0].parts[0].isExpanded, false);
    assert.equal(chat.reasoningActivities(chat.messages[0].parts[0]).map(activity => activity.tool).join(','), 'searchProducts');
});

test('stops the previous action when the gateway starts the next action', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'category-2',
        tool: 'searchCategories',
        state: 'running'
    });

    const activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.deepEqual(
        Array.from(activities, activity => [activity.id, activity.state, activity.isCurrentAction]),
        [['catalog-1', 'completed', false], ['category-2', 'running', true]]
    );
    assert.ok(Number(activities[0].completedAt) > 0);
});

test('keeps the last completed action shimmering until a newer action starts', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'catalog-1',
        tool: 'searchProducts',
        state: 'completed',
        result_count: 2
    });

    let activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.equal(activities[0].state, 'completed');
    assert.equal(activities[0].isCurrentAction, true);

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'category-2',
        tool: 'searchCategories',
        state: 'running'
    });

    activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.deepEqual(
        Array.from(activities, activity => [activity.id, activity.isCurrentAction]),
        [['catalog-1', false], ['category-2', true]]
    );
});

test('filters legacy Thinking text while retaining actions', () => {
    const chat = createChat();
    const part = {
        type: 'reasoning',
        events: [{
            id: 'tool-catalog-1',
            type: 'activity',
            tool: 'searchProducts',
            state: 'running'
        }],
        steps: [{
            id: 'legacy-step-1',
            type: 'step',
            content: 'Thinking text must remain visible.'
        }]
    };

    assert.equal(chat.reasoningSteps(part).length, 0);
    assert.deepEqual(Array.from(chat.reasoningTimeline(part), event => event.id), ['tool-catalog-1']);
    assert.deepEqual(chat.reasoningActivities(part), [part.events[0]]);
});

test('filters every legacy Thinking step from the activity timeline', () => {
    const chat = createChat();
    const part = {
        type: 'reasoning',
        events: [
            { id: 'empty-step', type: 'step', content: '' },
            { id: 'tool-1', type: 'activity', tool: 'searchProducts', state: 'running' }
        ],
        steps: [{ id: 'legacy-step', type: 'step', content: 'Visible Thinking text.' }]
    };

    assert.equal(chat.reasoningSteps(part).length, 0);
    assert.deepEqual(Array.from(chat.reasoningTimeline(part), event => event.id), ['tool-1']);
    assert.equal(chat.reasoningActivities(part)[0].tool, 'searchProducts');
});

test('retains streamed provider reasoning with actions through completion', () => {
    const chat = createChat();

    chat.handleStreamMessage({ type: 'thinking_delta', request_id: 'stream-1', step_id: 'draft', delta: 'Checking the catalogue.', visibility: 'public' });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'I found the matching products.' });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'completed',
        result_count: 2
    });
    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    const message = chat.messages[0];
    const reasoning = message.parts.find(part => part.type === 'reasoning');
    const text = message.parts.find(part => part.type === 'text');
    assert.ok(reasoning);
    assert.ok(text);
    assert.deepEqual(
        Array.from(chat.reasoningSteps(reasoning), step => [step.source, step.content, step.state]),
        [['provider_reasoning', 'Checking the catalogue.', 'running']]
    );
    assert.deepEqual(Array.from(chat.reasoningTimeline(reasoning), event => event.type), ['step', 'activity']);
    assert.equal(chat.reasoningActivities(reasoning)[0].state, 'completed');
    assert.equal(reasoning.isExpanded, false);
    assert.equal(chat.isLoading, false);
});

test('keeps an explicit collapse separate from automatic stream updates', () => {
    const chat = createChat();

    chat.handleStreamMessage({ type: 'thinking_delta', request_id: 'stream-1', step_id: 'draft', delta: 'Thinking stays in the timeline.', visibility: 'public' });
    assert.equal(chat.messages.length, 1);
    assert.deepEqual(
        Array.from(chat.reasoningSteps(chat.messages[0].parts[0]), step => step.source),
        ['provider_reasoning']
    );
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    const reasoning = chat.messages[0].parts[0];
    chat.toggleReasoning(reasoning);
    assert.equal(reasoning.isExpanded, false);
    assert.equal(reasoning.isManuallyCollapsed, true);

    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'The answer is still being prepared.' });
    assert.equal(reasoning.isExpanded, false);
    assert.equal(chat.reasoningSteps(reasoning).length, 1);
    assert.equal(chat.reasoningActivities(reasoning)[0].state, 'running');

    chat.toggleReasoning(reasoning);
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'completed'
    });
    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });
    assert.equal(reasoning.isExpanded, true);
    assert.equal(reasoning.isManuallyCollapsed, false);
    assert.equal(chat.reasoningSteps(reasoning).length, 1);
});

test('creates one reasoning part when a legacy action arrives before the first text chunk', () => {
    const chat = createChat();

    chat.thinkingSteps = [{ id: 'legacy-step', type: 'step', content: 'Legacy Thinking text.' }];
    chat.toolActivities = [{ id: 'legacy-tool', type: 'activity', tool: 'searchProducts', state: 'running' }];
    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Final text follows.' });

    assert.deepEqual(Array.from(chat.messages[0].parts, part => part.type), ['reasoning', 'text']);
    assert.equal(chat.messages[0].parts[0].steps.length, 0);
    assert.equal(chat.messages[0].parts[0].activities[0].tool, 'searchProducts');
    assert.equal(chat.messages[0].parts[0].isExpanded, false);
});

test('folds completed work history until its duration row is opened', () => {
    const chat = createChat();
    chat.isLoading = false;
    const message = {
        role: 'assistant',
        workedForMs: 3_000,
        parts: [{
            type: 'reasoning',
            isExpanded: false,
            isManuallyCollapsed: false,
            activitiesExpanded: false
        }]
    };

    assert.equal(chat.turnDividerLabel(message, 0), 'worked_for');
    assert.equal(chat.isTurnHistoryOpen(message, 0), false);

    chat.toggleTurnHistory(message, 0);
    assert.equal(chat.isTurnHistoryOpen(message, 0), true);
    assert.equal(message.parts[0].isExpanded, true);
    assert.equal(message.parts[0].activitiesExpanded, true);

    chat.toggleTurnHistory(message, 0);
    assert.equal(chat.isTurnHistoryOpen(message, 0), false);
    assert.equal(message.parts[0].isExpanded, false);
    assert.equal(message.parts[0].activitiesExpanded, false);
});

test('shows an action timer only while that action is running', () => {
    const chat = createChat();
    chat.streamNow = Date.now();
    const running = { state: 'running', startedAt: chat.streamNow - 1_200 };
    const completed = { ...running, state: 'completed', completedAt: chat.streamNow };

    assert.equal(chat.activityDurationLabel(running), '1s');
    assert.equal(chat.activityDurationLabel(completed), '');
});

test('renders each reasoning event only in the turn history timeline', () => {
    assert.match(conversationTemplate, /afd-ai-chat__turn-history-content/);
    assert.match(conversationTemplate, /reasoningTimeline\(part\)/);
    assert.match(
        conversationTemplate,
        /event\.isCurrentAction === true && isReasoningLive\(part, index\)/
    );
    assert.match(conversationTemplate, /messageRenderKey\(msg, index\)/);
    assert.match(conversationTemplate, /afd-ai-chat__turn-history-panel afd-ai-chat__collapsible/);
    assert.doesNotMatch(conversationTemplate, /x-show="isTurnHistoryOpen\(msg, index\)"/);
    assert.doesNotMatch(conversationTemplate, /afd-ai-chat__reasoning-accordion/);
    assert.doesNotMatch(conversationTemplate, /afd-ai-chat__activity-summary/);
    assert.doesNotMatch(conversationTemplate, /reasoningSummary\(part\)/);
    assert.doesNotMatch(conversationTemplate, /activitySummaryLabel\(part\)/);
    assert.ok(
        conversationTemplate.indexOf('class="afd-ai-chat__msg-bubble-ai"')
        < conversationTemplate.indexOf('class="afd-ai-chat__turn-history"')
    );
});

test('retains the live DOM key when durable history replaces a completed response', () => {
    const chat = createChat();
    const liveMessage = {
        role: 'assistant',
        request_id: 'stream-1',
        parts: [{ type: 'text', raw: 'Finished response.' }]
    };
    const liveKey = chat.messageRenderKey(liveMessage, 1);
    const durableReplacement = {
        ...liveMessage,
        entity_id: 42,
        created_at: '2026-08-22T12:00:00Z'
    };

    assert.equal(chat.messageRenderKey(durableReplacement, 1), liveKey);
    assert.equal(chat.messageRenderKey({ entity_id: 42, role: 'assistant' }, 1), 'message-42');
});

test('does not expose an unmarked provider reasoning frame when a discard frame arrives', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'thinking_step',
        request_id: 'stream-1',
        step_id: 'draft',
        content: 'Keep this Thinking text.'
    });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        tool: 'searchProducts',
        state: 'running'
    });
    chat.handleStreamMessage({ type: 'discard_thinking_text', request_id: 'stream-1' });

    assert.equal(chat.messages.length, 1);
    assert.equal(chat.reasoningSteps(chat.messages[0].parts[0]).length, 0);
    assert.equal(chat.reasoningActivities(chat.messages[0].parts[0])[0].state, 'running');
});

test('queues the guest email card until the final message text is complete', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'guest_order_access_required',
        request_id: 'stream-1',
        purpose: 'order',
        state: 'email',
        expires_at: Date.now() + 60_000
    });

    assert.equal(chat.messages.length, 0);
    assert.equal(chat.pendingGuestOrderAccessParts.length, 1);

    // The structured verification card is appended only after the final
    // customer-facing text, so the text always appears first.
    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Please verify your email.' });
    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });
    assert.deepEqual(
        Array.from(chat.messages[0].parts, (part) => part.type),
        ['text', 'guest_order_access']
    );
    assert.equal(chat.messages[0].parts[1].state, 'email');
});

test('does not revive the composer stop state when a stale status frame follows done', () => {
    const chat = createChat();

    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Completed response.' });
    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });
    assert.equal(chat.isLoading, false);
    assert.equal(chat.activeRequestId, null);

    // WebSocket frames already queued by the gateway can arrive after done.
    // They must never turn the Send button back into a Stop button.
    chat.handleStreamMessage({ type: 'status', request_id: 'stream-1', content: 'Working' });
    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'late-tool',
        state: 'running'
    });
    chat.handleStreamMessage({ type: 'status', content: 'Working from an older gateway frame' });

    assert.equal(chat.isLoading, false);
    assert.equal(chat.statusMessage, '');
});

test('ignores an uncorrelated request-less stream frame while a newer turn is active', () => {
    const chat = createChat();

    // A legacy gateway can still have an old frame queued after the shopper
    // has started the next request. Without a request id it cannot safely be
    // associated with the visible assistant bubble.
    chat.handleStreamMessage({
        type: 'chunk',
        content: 'Stale content from an earlier conversation.'
    });
    chat.handleStreamMessage({
        type: 'thinking_delta',
        content: 'Stale reasoning from an earlier conversation.'
    });

    assert.equal(chat.messages.length, 0);
    assert.equal(chat.currentAiMessageIndex, -1);

    chat.handleStreamMessage({
        type: 'chunk',
        request_id: 'stream-1',
        content: 'Current response.'
    });

    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].parts[0].raw, 'Current response.');
});

test('uses one content follower after a compact response completes', () => {
    const chat = createChat();
    const anchoredRequestIds = [];
    let scrollCalls = 0;
    chat.isAtChatBottom = true;
    chat.pinCurrentTurnToTop = requestId => anchoredRequestIds.push(requestId);
    chat.scrollToBottom = () => { scrollCalls += 1; };

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.deepEqual(anchoredRequestIds, []);
    assert.equal(scrollCalls, 1);

    const readerScrolledAway = createChat();
    readerScrolledAway.isAtChatBottom = false;
    readerScrolledAway.pinCurrentTurnToTop = requestId => anchoredRequestIds.push(requestId);
    readerScrolledAway.scrollToBottom = () => { scrollCalls += 1; };

    readerScrolledAway.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.deepEqual(anchoredRequestIds, []);
    assert.equal(scrollCalls, 2);
});

test('ends the composer request when gateway admission is busy', () => {
    const chat = createChat();
    let notice = null;
    chat.setTransportNotice = (...args) => { notice = args; };

    chat.handleStreamMessage({
        type: 'busy',
        request_id: 'stream-1',
        content: 'Image requests are temporarily limited.'
    });

    assert.equal(chat.isLoading, false);
    assert.equal(chat.activeRequestId, null);
    assert.deepEqual(Array.from(notice), [
        'ai-service-busy',
        'AI service is busy',
        'Image requests are temporarily limited.'
    ]);
});

test('renders an expired history form without returning its former address values', () => {
    const chat = createChat();
    const form = chat.createOrderAddressFormPart({
        type: 'order_address_form',
        form_id: 'expired-address-form-1',
        created_at: 100,
        expires_at: 200,
        order_number: '000001001',
        address_types: ['shipping'],
        address_type: 'shipping',
        addresses: { shipping: { firstname: 'Ada', street: ['1 Example Street'], country_id: 'DE' } },
        fields: [
            { code: 'firstname', label: 'First name', required: true },
            { code: 'street', label: 'Street', required: true }
        ],
        countries: [{ value: 'DE', label: 'Germany' }],
        regions: {}
    });

    assert.equal(form.status, 'expired');
    assert.equal(form.address.firstname, '');
    assert.equal(form.address.street[0], '');
    assert.equal(form.address.country_id, '');
    assert.equal(form.addresses.shipping.firstname, '');
});

test('expires every older address form when a newer form is appended', () => {
    const chat = createChat();
    const base = {
        type: 'order_address_form',
        created_at: Date.now(),
        expires_at: Date.now() + 15 * 60_000,
        resource_type: 'customer_account',
        address_types: ['shipping'],
        address_type: 'shipping',
        addresses: { shipping: { firstname: 'Ada', country_id: 'DE' } },
        fields: [{ code: 'firstname', label: 'First name', required: true }],
        countries: [{ value: 'DE', label: 'Germany' }],
        regions: {}
    };
    const oldForm = chat.createOrderAddressFormPart({
        ...base,
        form_id: 'account-address-old',
        action_token: 'old-token'
    });
    chat.messages = [{ role: 'assistant', parts: [oldForm] }];
    chat.currentAiMessageIndex = 0;

    const newForm = chat.appendOrderAddressForm({
        ...base,
        form_id: 'account-address-new',
        action_token: 'new-token'
    });

    assert.equal(oldForm.status, 'expired');
    assert.equal(oldForm.actionToken, '');
    assert.equal(oldForm.address.firstname, '');
    assert.equal(newForm.status, 'editing');
    assert.equal(newForm.actionToken, 'new-token');
    assert.match(chat.orderAddressCountdownLabel(newForm), /^1[45]:[0-5][0-9]$/);
});
