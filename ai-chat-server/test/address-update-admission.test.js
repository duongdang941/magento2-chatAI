import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activeAddressFormCacheKey,
    createAddressUpdateAdmission
} from '../services/customer/address-update-admission.js';

test('uses one canonical owner-scoped key for activation and history hydration', () => {
    assert.equal(
        activeAddressFormCacheKey({ customerId: 7, sessionId: 'ignored' }, 11),
        'active-address-form:customer:7:11'
    );
    assert.equal(
        activeAddressFormCacheKey({ customerId: null, sessionId: 'guest-session' }, 11),
        'active-address-form:session:guest-session:11'
    );
});

test('activates only a non-expired form in its owner-scoped cache', async () => {
    const writes = [];
    const admission = createAddressUpdateAdmission({
        runtime: {
            setAuthCache: async (...args) => writes.push(args)
        },
        getConfig: async () => ({})
    });
    const client = { customerId: 7, sessionId: 'session' };

    assert.equal(await admission.activate(client, 11, {
        form_id: 'form-1',
        expires_at: Date.now() + 60000
    }), true);
    assert.equal(await admission.activate(client, 11, {
        form_id: 'expired',
        expires_at: Date.now() - 1
    }), false);
    assert.match(writes[0][0], /^active-address-form:customer:7:11$/);
    assert.equal(writes.length, 1);
});
