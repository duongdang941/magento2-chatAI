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
        document: {},
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
    vm.runInNewContext(streamSource, context); vm.runInNewContext(orderAddressSource, context);
    const moduleContext = {
        config: {},
        urls: {},
        helpers: {
            sanitizeHtml: (value) => String(value || ''),
            sanitizeStreamingHtml: (value) => String(value || ''),
            hydrateProductGridHtml: (value) => String(value || '')
        }
    };
    const rendererMethods = browserWindow.AfdAiChat.streamRendererMethods(moduleContext);
    const methods = browserWindow.AfdAiChat.streamMethods(moduleContext); const orderAddressMethods = browserWindow.AfdAiChat.orderAddressStreamMethods(moduleContext);

    return {
        ...rendererMethods,
        ...methods,
        ...orderAddressMethods,
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
