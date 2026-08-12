import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryMessagePreparer } from '../services/conversation/history-message-preparer.js';
import { verifyCatalogPageToken } from '../services/catalog/catalog-pagination.js';

function createPreparer(overrides = {}) {
    return createHistoryMessagePreparer({
        runtime: { getAuthCache: async () => null },
        normalizeStoredAssistantMessage: message => structuredClone(message),
        hasActiveSupportEmailVerification: () => false,
        listSupportCases: async () => ({ status: 'success', cases: [] }),
        supportPortalIdentity: () => null,
        hasActiveGuestOrderAccess: () => false,
        addressUpdateAdmission: { activate: async () => true },
        ...overrides
    });
}

test('expired history forms are redacted before returning them to a guest', async () => {
    const prepare = createPreparer();
    const [message] = await prepare([{
        role: 'assistant',
        parts: [{
            type: 'order_address_form',
            form_id: 'expired-form',
            resource_type: 'order',
            expires_at: Date.now() - 1000,
            address_types: ['billing', 'shipping'],
            action_token: 'old-token',
            addresses: {
                billing: { firstname: 'Private' },
                shipping: { street: ['Secret street'] }
            }
        }]
    }], { customerId: null, sessionId: 'guest' }, 17);

    const form = message.parts[0];
    assert.equal(form.action_token, '');
    assert.deepEqual(form.addresses, { billing: {}, shipping: {} });
    assert.ok(form.expires_at < Date.now());
});

test('active account form uses the canonical cache key and is activated once', async () => {
    const originalSecret = process.env.AI_WS_TICKET_SECRET;
    process.env.AI_WS_TICKET_SECRET = 'history-preparer-test-secret-at-least-32-characters';
    const reads = [];
    const activations = [];
    try {
        const prepare = createPreparer({
            runtime: {
                getAuthCache: async key => {
                    reads.push(key);
                    return { formId: 'active-form' };
                }
            },
            addressUpdateAdmission: {
                activate: async (...args) => activations.push(args)
            }
        });
        const expiresAt = Date.now() + 60000;
        const [message] = await prepare([{
            role: 'assistant',
            parts: [{
                type: 'order_address_form',
                form_id: 'active-form',
                resource_type: 'customer_account',
                expires_at: expiresAt,
                address_types: ['billing'],
                addresses: { billing: { firstname: 'Ada' } }
            }]
        }], { customerId: 7, sessionId: 'session' }, 11);

        assert.deepEqual(reads, ['active-address-form:customer:7:11']);
        assert.match(message.parts[0].action_token, /^[^.]+\.[^.]+$/);
        assert.equal(activations.length, 1);
    } finally {
        if (originalSecret === undefined) delete process.env.AI_WS_TICKET_SECRET;
        else process.env.AI_WS_TICKET_SECRET = originalSecret;
    }
});

test('reissues a fresh continuation for a persisted product result set', async () => {
    const prepare = createPreparer();
    const [message] = await prepare([{
        role: 'assistant',
        parts: [{
            type: 'products',
            payload: {
                query: 'adler figur',
                items: Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })),
                total: 246,
                pagination: {
                    page: 1,
                    page_size: 5,
                    total: 246,
                    returned: 5,
                    has_more: true
                },
                scope: { category_id: 24, direct_add_only: false }
            }
        }]
    }], { customerId: null, sessionId: 'guest' }, 17);

    const payload = message.parts[0].payload;
    assert.equal(payload.pagination.can_load_more, true);
    assert.equal(payload.pagination.truncated_for_chat, false);
    assert.deepEqual(verifyCatalogPageToken(payload.continuation), {
        query: 'adler figur',
        categoryId: 24,
        page: 2,
        pageSize: 5
    });
});
