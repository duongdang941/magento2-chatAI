import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupportBroadcaster } from '../services/support-broadcaster.js';

test('routes support messages only to their customer and subscribed admins', () => {
    const customerFrames = [];
    const otherFrames = [];
    const adminFrames = [];
    const customer = { send: (frame) => customerFrames.push(frame) };
    const other = { send: (frame) => otherFrames.push(frame) };
    const admin = { send: (frame) => adminFrames.push(frame) };
    const broadcaster = createSupportBroadcaster({
        clientData: new Map([
            [customer, { role: 'customer', customerId: 7 }],
            [other, { role: 'customer', customerId: 8 }],
            [admin, { role: 'support_admin', supportConversationId: 11 }]
        ]),
        isSocketOpen: () => true
    });

    assert.equal(broadcaster.broadcastSupportMessage({
        conversationId: 11,
        customerId: 7,
        guestId: '',
        messageId: 42
    }), 2);
    assert.equal(customerFrames.length, 1);
    assert.equal(otherFrames.length, 0);
    assert.equal(adminFrames.length, 1);
});
