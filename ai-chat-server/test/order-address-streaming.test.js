import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const streamSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream.js', import.meta.url),
    'utf8'
);
const orderAddressSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/order-address-stream.js', import.meta.url), 'utf8');
const guestOrderStreamSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/guest-order-stream.js', import.meta.url), 'utf8');
const reasoningStreamSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/reasoning-stream.js', import.meta.url), 'utf8');
const visualSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/visual.js', import.meta.url), 'utf8');
const imageFeedbackStreamSource = fs.readFileSync(new URL('../../view/frontend/web/js/chat/image-feedback-stream.js', import.meta.url), 'utf8');
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
        ResizeObserver: undefined,
        JSON,
        Intl
    };
    vm.runInNewContext(streamRendererSource, context);
    vm.runInNewContext(streamSource, context); vm.runInNewContext(visualSource, context); vm.runInNewContext(orderAddressSource, context); vm.runInNewContext(guestOrderStreamSource, context); vm.runInNewContext(reasoningStreamSource, context); vm.runInNewContext(imageFeedbackStreamSource, context); vm.runInNewContext(shellSource, context);
    const moduleContext = {
        config: {},
        urls: {},
        helpers: {
            sanitizeHtml: (value) => String(value || ''),
            sanitizeStreamingHtml: (value) => String(value || ''),
            sanitizeStreamingHtmlBlocks: (value) => [String(value || '')],
            splitHtmlBlocks: (value) => String(value || '') ? [String(value)] : [],
            hydrateProductGridHtml: (value) => String(value || ''),
            escapeHtml: (value) => String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\"/g, '&quot;')
                .replace(/'/g, '&#039;')
        }
    };
    const rendererMethods = browserWindow.AfdAiChat.streamRendererMethods(moduleContext);
    const methods = browserWindow.AfdAiChat.streamMethods(moduleContext);
    const visualMethods = browserWindow.AfdAiChat.visualMethods(moduleContext);
    const orderAddressMethods = browserWindow.AfdAiChat.orderAddressStreamMethods(moduleContext);
    const guestOrderMethods = browserWindow.AfdAiChat.guestOrderStreamMethods(moduleContext);
    const reasoningMethods = browserWindow.AfdAiChat.reasoningStreamMethods(moduleContext);
    const imageFeedbackMethods = browserWindow.AfdAiChat.imageFeedbackStreamMethods(moduleContext);
    const shellMethods = browserWindow.AfdAiChat.shellMethods(moduleContext);

    return {
        ...rendererMethods,
        ...methods,
        ...visualMethods,
        ...orderAddressMethods,
        ...guestOrderMethods,
        ...reasoningMethods,
        ...imageFeedbackMethods,
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
        toolActivityLabel(activity) { return String(activity?.label || activity?.tool || ''); },
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

test('ignores raw provider reasoning and starts the timeline at a verified action', () => {
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

    assert.equal(chat.currentAiMessageIndex, -1);
    assert.equal(chat.messages.length, 0);

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        display_key: 'catalog-search',
        tool: 'searchProducts',
        state: 'running',
        label: 'Đang tìm kiếm sản phẩm trong cửa hàng'
    });
    chat.handleStreamMessage({ type: 'chunk', request_id: 'stream-1', content: 'Still composing.' });
    assert.deepEqual(
        Array.from(chat.messages[0].parts, part => part.type),
        ['reasoning', 'text']
    );
    assert.equal(chat.messages[0].parts[0].isExpanded, false);
    const reasoningId = chat.messages[0].parts[0].id;
    assert.equal(chat.reasoningSteps(chat.messages[0].parts[0]).length, 0);

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'tool-catalog-1',
        display_key: 'catalog-search',
        tool: 'searchProducts',
        state: 'completed',
        result_count: 2,
        label: 'Đã tìm kiếm sản phẩm trong cửa hàng'
    });
    assert.equal(chat.messages[0].parts[0].isExpanded, true);

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });
    assert.equal(chat.messages[0].parts[0].id, reasoningId);
    assert.equal(chat.messages[0].parts[0].isExpanded, false);
    assert.deepEqual(
        Array.from(chat.reasoningActivities(chat.messages[0].parts[0]), activity => [activity.id, activity.label]),
        [['tool-catalog-1', 'Đã tìm kiếm sản phẩm trong cửa hàng']]
    );
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

test('shows a completed action label only immediately before the next action starts', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'catalog-1',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm màu đen'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'catalog-1',
        tool: 'searchProducts', state: 'completed', label: 'Đã tìm xong sản phẩm màu đen'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'category-2',
        tool: 'listCategories', state: 'running', label: 'Đang kiểm tra danh mục sản phẩm'
    });

    const activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.deepEqual(
        Array.from(activities, activity => [activity.state, activity.label, activity.isCurrentAction]),
        [
            ['completed', 'Đã tìm xong sản phẩm màu đen', false],
            ['running', 'Đang kiểm tra danh mục sản phẩm', true]
        ]
    );
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

test('keeps a store search and category search as separate chronological actions', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1', display_key: 'catalog-search-store',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm trong cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1', display_key: 'catalog-search-store',
        tool: 'searchProducts', state: 'completed', label: 'Đã tìm kiếm sản phẩm trong cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'categories-1', display_key: 'catalog-categories',
        tool: 'listCategories', state: 'completed', label: 'Đã kiểm tra danh mục sản phẩm'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-2', display_key: 'catalog-search-category-44',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm trong danh mục Áo khoác'
    });

    assert.deepEqual(
        Array.from(chat.reasoningActivities(chat.messages[0].parts[0]), activity => [activity.id, activity.state, activity.label]),
        [
            ['search-1', 'completed', 'Đã tìm kiếm sản phẩm trong cửa hàng'],
            ['categories-1', 'completed', 'Đã kiểm tra danh mục sản phẩm'],
            ['search-2', 'running', 'Đang tìm kiếm sản phẩm trong danh mục Áo khoác']
        ]
    );
});

test('retains every action when multiple executions share the same display key', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1', display_key: 'catalog-search-store',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm sản phẩm màu đen trong cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1', display_key: 'catalog-search-store',
        tool: 'searchProducts', state: 'completed', label: 'Đã tìm xong sản phẩm màu đen trong cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-2', display_key: 'catalog-search-store',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm lại sản phẩm màu đen trong cửa hàng'
    });

    assert.deepEqual(
        Array.from(chat.reasoningActivities(chat.messages[0].parts[0]), activity => [activity.id, activity.state, activity.label]),
        [
            ['search-1', 'completed', 'Đã tìm xong sản phẩm màu đen trong cửa hàng'],
            ['search-2', 'running', 'Đang tìm lại sản phẩm màu đen trong cửa hàng']
        ]
    );
});

test('coalesces consecutive catalogue refinements by gateway timeline key, not label text', () => {
    const chat = createChat();
    const timelineKey = 'timeline-catalog-search-store';

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1',
        continuation_key: 'activity-0123456789abcdef01234567', timeline_key: timelineKey,
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm trên toàn bộ cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-2',
        continuation_key: 'activity-abcdef0123456789abcdef01', timeline_key: timelineKey,
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm trên toàn bộ cửa hàng'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-2',
        continuation_key: 'activity-abcdef0123456789abcdef01', timeline_key: timelineKey,
        tool: 'searchProducts', state: 'completed', result_count: 1,
        label: 'Đã tìm kiếm sản phẩm trên toàn bộ cửa hàng'
    });

    assert.deepEqual(
        Array.from(chat.reasoningActivities(chat.messages[0].parts[0]), activity => [
            activity.id,
            activity.timelineKey,
            activity.state,
            activity.label
        ]),
        [[
            'search-1',
            timelineKey,
            'completed',
            'Đã tìm kiếm sản phẩm trên toàn bộ cửa hàng'
        ]]
    );
});

test('continues only the immediately active opaque operation key without comparing labels', () => {
    const chat = createChat();
    const storeSearchKey = 'activity-111111111111111111111111';
    const categoryLookupKey = 'activity-222222222222222222222222';
    const refinedSearchKey = 'activity-333333333333333333333333';

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1',
        continuation_key: storeSearchKey, tool: 'searchProducts', state: 'running',
        label: 'First provider wording'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-1',
        continuation_key: storeSearchKey, tool: 'searchProducts', state: 'completed',
        label: 'First operation complete'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'categories-1',
        continuation_key: categoryLookupKey, tool: 'listCategories', state: 'running',
        label: 'A distinct operation'
    });

    // A second real execution with the same operation key must continue the
    // active category row even though both its server id and label change.
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'categories-2',
        continuation_key: categoryLookupKey, tool: 'listCategories', state: 'running',
        label: 'Different wording for the same operation'
    });

    let activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.deepEqual(
        Array.from(activities, activity => [activity.id, activity.state, activity.isCurrentAction]),
        [
            ['search-1', 'completed', false],
            ['categories-1', 'running', true]
        ]
    );

    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'categories-2',
        continuation_key: categoryLookupKey, tool: 'listCategories', state: 'completed',
        label: 'Same operation finished'
    });
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'search-2',
        continuation_key: refinedSearchKey, tool: 'searchProducts', state: 'running',
        label: 'A new operation'
    });

    activities = chat.reasoningActivities(chat.messages[0].parts[0]);
    assert.deepEqual(
        Array.from(activities, activity => [activity.id, activity.state, activity.label, activity.isCurrentAction]),
        [
            ['search-1', 'completed', 'First operation complete', false],
            ['categories-1', 'completed', 'Same operation finished', false],
            ['search-2', 'running', 'A new operation', true]
        ]
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

test('keeps only verified actions when a provider streams raw reasoning', () => {
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
    assert.equal(chat.reasoningSteps(reasoning).length, 0);
    assert.deepEqual(Array.from(chat.reasoningTimeline(reasoning), event => event.type), ['activity']);
    assert.equal(chat.reasoningActivities(reasoning)[0].state, 'completed');
    assert.equal(reasoning.isExpanded, false);
    assert.equal(chat.isLoading, false);
});

test('keeps an explicit collapse separate from automatic stream updates', () => {
    const chat = createChat();

    chat.handleStreamMessage({ type: 'thinking_delta', request_id: 'stream-1', step_id: 'draft', delta: 'Thinking stays in the timeline.', visibility: 'public' });
    assert.equal(chat.messages.length, 0);
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
    assert.equal(chat.reasoningSteps(reasoning).length, 0);
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
    assert.equal(chat.reasoningSteps(reasoning).length, 0);
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

test('shows the total completed-work duration only in the turn header', () => {
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

    chat.t = (key, values = {}) => key === 'worked_for'
        ? `Worked for ${values[1]}`
        : key;
    assert.equal(chat.turnDividerLabel(message, 0), 'Worked for 3s');
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

test('keeps the persisted action presentation and total duration after history hydration', () => {
    const chat = createChat();
    chat.isLoading = false;
    const message = chat.normalizeLoadedMessage({
        entity_id: 77,
        role: 'assistant',
        worked_for_ms: 12_345,
        parts: [{
            type: 'reasoning',
            elapsedMs: 12_345,
            events: [{
                id: 'catalog-search',
                type: 'activity',
                tool: 'searchProducts',
                state: 'completed',
                label: 'Đã tìm kiếm sản phẩm trong danh mục Textilien',
                language: 'vi',
                turn_summary: 'Đã xử lý trong {duration}'
            }]
        }]
    });

    assert.equal(message.workedForMs, 12_345);
    assert.equal(message.parts[0].events[0].label, 'Đã tìm kiếm sản phẩm trong danh mục Textilien');
    assert.equal(message.parts[0].events[0].language, 'vi');
    assert.equal(message.parts[0].elapsedMs, 12_345);
    chat.t = (key, values = {}) => key === 'worked_for'
        ? `Worked for ${values[1]}`
        : key;
    assert.equal(chat.turnDividerLabel(message, 0), 'Đã xử lý trong 12s');

    const mergedWithLegacyZero = { ...message, workedForMs: 0, worked_for_ms: 12_345 };
    assert.equal(chat.turnDividerLabel(mergedWithLegacyZero, 0), 'Đã xử lý trong 12s');
});

test('uses a locale fallback only for a legacy action without a dynamic turn summary', () => {
    const chat = createChat();
    chat.isLoading = false;
    const message = {
        role: 'assistant',
        workedForMs: 0,
        parts: [{
            type: 'reasoning',
            events: [{
                id: 'catalog-search', type: 'activity', tool: 'searchProducts', state: 'completed',
                language: 'vi', label: 'Đã tìm kiếm sản phẩm trong cửa hàng'
            }]
        }]
    };

    assert.equal(chat.turnDividerLabel(message, 0), 'actions_checked_1');
});

test('uses the gateway-provided generic total-work summary, not the action label', () => {
    const chat = createChat();
    chat.isLoading = false;
    const message = {
        role: 'assistant',
        workedForMs: 13_000,
        parts: [{
            type: 'reasoning',
            events: [{
                id: 'category-products',
                type: 'activity',
                tool: 'searchProducts',
                state: 'completed',
                label: 'Retrieved T-Shirts & Polohemden products',
                turn_summary: 'Finished processing in {duration}'
            }]
        }]
    };

    chat.t = (key, values = {}) => key === 'worked_for'
        ? `Worked for ${values[1]}`
        : key;
    assert.equal(chat.turnDividerLabel(message, 0), 'Finished processing in 13s');
});

test('uses a live work title while keeping the actual action in the timeline', () => {
    const chat = createChat();
    chat.isLoading = true;
    chat.currentAiMessageIndex = 0;
    chat.responseStartedAt = Date.now() - 2_200;
    chat.streamNow = Date.now();
    const message = {
        role: 'assistant',
        parts: [{
            type: 'reasoning',
            events: [{
                id: 'catalog-search', type: 'activity', tool: 'searchProducts', state: 'running',
                language: 'vi', label: 'Đang tìm kiếm sản phẩm trong danh mục Áo khoác',
                turn_summary: 'Đang xử lý trong {duration}'
            }]
        }]
    };
    chat.messages = [message];

    chat.t = (key, values = {}) => key === 'working_for'
        ? `Working for ${values[1]}`
        : key;
    assert.equal(chat.turnDividerLabel(message, 0), 'Đang xử lý trong 2s');
    assert.equal(chat.toolActivityLabel(message.parts[0].events[0]), 'Đang tìm kiếm sản phẩm trong danh mục Áo khoác');
});

test('does not render an action timer', () => {
    const chat = createChat();
    chat.streamNow = Date.now();
    const running = { state: 'running', startedAt: chat.streamNow - 1_200 };
    const completed = { ...running, state: 'completed', completedAt: chat.streamNow };

    assert.equal(chat.activityDurationLabel(running), '');
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
    assert.doesNotMatch(conversationTemplate, /afd-ai-chat__tool-activity-timer/);
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

test('settles the matching action when the gateway returns a terminal error', () => {
    const chat = createChat();

    chat.handleStreamMessage({
        type: 'tool_activity',
        request_id: 'stream-1',
        activity_id: 'categories-1',
        display_key: 'catalog-categories',
        tool: 'listCategories',
        state: 'running',
        label: 'Đang kiểm tra danh mục sản phẩm'
    });
    chat.handleStreamMessage({
        type: 'error',
        request_id: 'stream-1',
        content: 'The store service timed out.'
    });

    assert.equal(chat.isLoading, false);
    assert.equal(chat.activeRequestId, null);
    assert.equal(chat.messages.at(-1).parts[0].type, 'text');
    assert.match(chat.messages.at(-1).parts[0].html, /The store service timed out/);
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

test('keeps the Thinking placeholder until an assistant response exists', () => {
    const thinkingPlaceholder = conversationTemplate.slice(
        conversationTemplate.indexOf('<!-- Pre-message status placeholder.'),
        conversationTemplate.indexOf('<!-- Codex reserves space below a short active turn')
    );

    assert.match(
        thinkingPlaceholder,
        /isLoading\s+&& !isHistoryLoading\s+&& currentAiMessageIndex === -1"\s+class="afd-ai-chat__msg-ai afd-ai-chat__msg-ai--thinking"/
    );
});

test('releases the turn anchor and shows a notice when done has no assistant response', () => {
    const chat = createChat();
    let notice = null;
    chat.isTurnStartPinned = true;
    chat.pinnedTurnRequestId = 'stream-1';
    chat.setTransportNotice = (...args) => { notice = args; };

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.equal(chat.isLoading, false);
    assert.equal(chat.isTurnStartPinned, false);
    assert.equal(chat.pinnedTurnRequestId, '');
    assert.deepEqual(Array.from(notice), [
        'empty-ai-response',
        'AI response unavailable',
        'The AI service ended without a response. Please try again.'
    ]);
});

test('does not treat an action-only timeline as a completed assistant response', () => {
    const chat = createChat();
    let notice = null;
    chat.isTurnStartPinned = true;
    chat.pinnedTurnRequestId = 'stream-1';
    chat.setTransportNotice = (...args) => { notice = args; };
    chat.handleStreamMessage({
        type: 'tool_activity', request_id: 'stream-1', activity_id: 'catalog-1',
        tool: 'searchProducts', state: 'running', label: 'Đang tìm kiếm sản phẩm màu đen'
    });

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.equal(chat.isTurnStartPinned, false);
    assert.deepEqual(Array.from(notice), [
        'empty-ai-response',
        'AI response unavailable',
        'The AI service ended without a response. Please try again.'
    ]);
});

test('keeps the anchor when the completed turn has an assistant response', () => {
    const chat = createChat();
    let notice = null;
    chat.isTurnStartPinned = true;
    chat.pinnedTurnRequestId = 'stream-1';
    chat.messages.push({
        role: 'assistant',
        request_id: 'stream-1',
        parts: [{ type: 'text', raw: 'The response is visible.' }]
    });
    chat.setTransportNotice = (...args) => { notice = args; };

    chat.handleStreamMessage({ type: 'done', request_id: 'stream-1' });

    assert.equal(chat.isTurnStartPinned, true);
    assert.equal(chat.pinnedTurnRequestId, 'stream-1');
    assert.equal(notice, null);
});

test('releases the empty turn anchor when the secure socket disconnects', () => {
    const chat = createChat();
    let notice = null;
    let scrollCalls = 0;
    chat.isTurnStartPinned = true;
    chat.pinnedTurnRequestId = 'stream-1';
    chat.setTransportNotice = (...args) => { notice = args; };
    chat.scrollToBottom = () => { scrollCalls += 1; };

    chat.handleActiveRequestDisconnect();

    assert.equal(chat.isLoading, false);
    assert.equal(chat.isTurnStartPinned, false);
    assert.equal(chat.pinnedTurnRequestId, '');
    assert.equal(scrollCalls, 1);
    assert.deepEqual(Array.from(notice), [
        'response-interrupted',
        'Response interrupted',
        'The secure chat connection was interrupted. Please retry your message.'
    ]);
});

test('ends the composer request when gateway admission is busy', () => {
    const chat = createChat();
    let notice = null;
    chat.isTurnStartPinned = true;
    chat.pinnedTurnRequestId = 'stream-1';
    chat.setTransportNotice = (...args) => { notice = args; };

    chat.handleStreamMessage({
        type: 'busy',
        request_id: 'stream-1',
        content: 'Image requests are temporarily limited.'
    });

    assert.equal(chat.isLoading, false);
    assert.equal(chat.activeRequestId, null);
    assert.equal(chat.isTurnStartPinned, false);
    assert.equal(chat.pinnedTurnRequestId, '');
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
