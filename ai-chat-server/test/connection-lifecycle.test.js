import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionLifecycle } from '../services/gateway/connection-lifecycle.js';

function setup(client) {
    const ws = { id: 'socket-1' };
    const clientData = new Map([[ws, client]]);
    const events = [];
    const lifecycle = createConnectionLifecycle({
        clientData,
        wss: { clients: new Set([ws]) },
        metrics: { increment: name => events.push(['metric', name]) },
        cancelActiveRun: socket => events.push(['cancel', socket]),
        browserCartBridge: { rejectAll: socket => events.push(['reject', socket]) },
        broadcastSupportTypingToCustomers: payload => events.push(['customer_typing', payload]),
        broadcastSupportTypingToAdmins: payload => events.push(['admin_typing', payload]),
        logger: { log: value => events.push(['log', value]), error: value => events.push(['error', value]) }
    });
    return { ws, clientData, events, lifecycle };
}

test('close cleanup clears support typing and removes the socket', () => {
    const { ws, clientData, events, lifecycle } = setup({
        role: 'support_admin', supportConversationId: 42, adminName: 'Ada'
    });
    lifecycle.handleClose(ws);
    assert.equal(clientData.has(ws), false);
    assert.deepEqual(events.slice(0, 3), [
        ['customer_typing', { conversationId: 42, typing: false, agentLabel: 'Ada' }],
        ['cancel', ws],
        ['reject', ws]
    ]);
    assert.equal(events.at(-1)[1], 'Client disconnected [total=1]');
});

test('error cleanup clears customer typing and records websocket error', () => {
    const { ws, clientData, events, lifecycle } = setup({ activeSupportConversationId: 7 });
    lifecycle.handleError(ws, new Error('boom'));
    assert.equal(clientData.has(ws), false);
    assert.deepEqual(events[0], ['error', 'WebSocket error:']);
    assert.deepEqual(events[1], ['admin_typing', { conversationId: 7, typing: false }]);
    assert.deepEqual(events.at(-1), ['metric', 'websocket_error']);
});
