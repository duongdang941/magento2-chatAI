import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCartBridge } from '../services/customer/browser-cart-bridge.js';

function createSocket() {
    const sent = [];
    return {
        OPEN: 1,
        readyState: 1,
        sent,
        send(message) {
            sent.push(JSON.parse(message));
        }
    };
}

test('requests a browser cart mutation and returns the verified browser result', async () => {
    const socket = createSocket();
    const bridge = new BrowserCartBridge({ isSocketOpen: (candidate) => candidate.readyState === candidate.OPEN });
    const pending = bridge.request(socket, {
        requestId: 'chat-1',
        cart: {
            sku: 'JACKET-1',
            qty: 2,
            selectedOptions: { farbe: 'Blau' }
        }
    });

    assert.equal(socket.sent.length, 1);
    assert.deepEqual(socket.sent[0].cart, {
        action: 'add',
        sku: 'JACKET-1',
        qty: 2,
        cartTarget: 'checkout',
        selectedOptions: { farbe: 'Blau' }
    });

    assert.equal(bridge.resolve(socket, {
        request_id: 'chat-1',
        cart_request_id: socket.sent[0].cart_request_id,
        result: { status: 'success', product: 'Jacket', qty: 2 }
    }), true);
    assert.deepEqual(await pending, { status: 'success', product: 'Jacket', qty: 2 });
});

test('does not allow a response from a different chat request to settle a cart mutation', async () => {
    const socket = createSocket();
    const bridge = new BrowserCartBridge({ isSocketOpen: (candidate) => candidate.readyState === candidate.OPEN });
    const pending = bridge.request(socket, {
        requestId: 'chat-2',
        cart: { sku: 'JACKET-2' }
    });

    assert.equal(bridge.resolve(socket, {
        request_id: 'another-chat',
        cart_request_id: socket.sent[0].cart_request_id,
        result: { status: 'success' }
    }), false);

    assert.equal(bridge.resolve(socket, {
        request_id: 'chat-2',
        cart_request_id: socket.sent[0].cart_request_id,
        result: { status: 'requires_customer_action', reason: 'missing_variant_options' }
    }), true);
    assert.deepEqual(await pending, {
        status: 'requires_customer_action',
        reason: 'missing_variant_options'
    });
});

test('preserves an explicit Quote Cart target without allowing other targets', () => {
    const bridge = new BrowserCartBridge();

    assert.deepEqual(
        bridge.normalizeCart({ sku: 'QUOTE-1', cartTarget: 'quote' }),
        { action: 'add', sku: 'QUOTE-1', qty: 1, cartTarget: 'quote', selectedOptions: {} }
    );
    assert.deepEqual(
        bridge.normalizeCart({ sku: 'CART-1', cartTarget: 'request_quote' }),
        { action: 'add', sku: 'CART-1', qty: 1, cartTarget: 'checkout', selectedOptions: {} }
    );
});

test('requests removal from the explicitly selected Quote Cart', async () => {
    const socket = createSocket();
    const bridge = new BrowserCartBridge({ isSocketOpen: (candidate) => candidate.readyState === candidate.OPEN });
    const pending = bridge.request(socket, {
        requestId: 'chat-remove-1',
        cart: { action: 'remove', sku: 'QUOTE-REMOVE-1', cartTarget: 'quote' }
    });

    assert.equal(socket.sent[0].type, 'cart_remove_request');
    assert.deepEqual(socket.sent[0].cart, {
        action: 'remove',
        sku: 'QUOTE-REMOVE-1',
        qty: 1,
        cartTarget: 'quote',
        selectedOptions: {}
    });

    bridge.resolve(socket, {
        request_id: 'chat-remove-1',
        cart_request_id: socket.sent[0].cart_request_id,
        result: { status: 'success', sku: 'QUOTE-REMOVE-1', cart_type: 'request_quote' }
    });
    assert.deepEqual(await pending, {
        status: 'success',
        sku: 'QUOTE-REMOVE-1',
        cart_type: 'request_quote'
    });
});
