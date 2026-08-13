import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCustomerAddressFormPayload,
    buildOrderAddressFormPayload,
    isCustomerAddressChangeRequest,
    isCustomerAddressRequest,
    isOrderAddressChangeRequest,
    normalizeOrderAddressFormPart
} from '../services/customer/order-address-form.js';

const TOKEN_SECRET = 'test-address-form-secret-that-is-long-enough';

test('recognizes account-address requests separately from order addresses', () => {
    assert.equal(isCustomerAddressRequest('Cho tôi biết địa chỉ billing và shipping của tài khoản của tôi'), true);
    assert.equal(isCustomerAddressRequest('Change my default shipping address'), true);
    assert.equal(isCustomerAddressRequest('Đổi địa chỉ giao hàng của đơn hàng 1001'), false);
    assert.equal(isCustomerAddressChangeRequest('Cho tôi biết địa chỉ billing và shipping của tài khoản của tôi'), false);
    assert.equal(isCustomerAddressChangeRequest('Tôi muốn sửa địa chỉ billing mặc định'), true);
    assert.equal(isCustomerAddressChangeRequest('Change my default shipping address'), true);
    assert.equal(isCustomerAddressChangeRequest('Đổi địa chỉ giao hàng của đơn hàng 1001'), false);
});

test('builds a logged-in account address form without requiring an order number', () => {
    const form = buildCustomerAddressFormPayload('getCustomerAddresses', {
        status: 'success',
        addresses: {
            billing: { firstname: 'Ada', street: ['Billing Street'], country_id: 'DE' },
            shipping: { firstname: 'Ada', street: ['Shipping Street'], country_id: 'DE' }
        },
        address_form: {
            fields: [{ code: 'firstname', label: 'First name', required: true }],
            countries: [{ value: 'DE', label: 'Germany' }],
            regions: {}
        }
    }, { customerId: 7, conversationId: 21, tokenSecret: TOKEN_SECRET, requestAddressForm: true });

    assert.equal(form.resource_type, 'customer_account');
    assert.equal(form.access_scope, 'customer');
    assert.equal(form.order_number, '');
    assert.ok(form.action_token);
    assert.deepEqual(form.address_types, ['billing', 'shipping']);
    assert.equal(normalizeOrderAddressFormPart(form).resource_type, 'customer_account');
    assert.equal(buildCustomerAddressFormPayload('getCustomerAddresses', {
        status: 'requires_customer_action',
        reason: 'not_logged_in'
    }, { requestAddressForm: true }), null);
    assert.equal(buildCustomerAddressFormPayload('getCustomerAddresses', {
        status: 'success',
        addresses: { billing: { firstname: 'Ada' } }
    }, { customerId: 7, conversationId: 21, tokenSecret: TOKEN_SECRET }), null);
});

test('recognizes explicit order-address change requests without treating status checks as edits', () => {
    assert.equal(isOrderAddressChangeRequest('Tôi muốn đổi địa chỉ giao hàng cho đơn #1001'), true);
    assert.equal(isOrderAddressChangeRequest('Please change my billing address'), true);
    assert.equal(isOrderAddressChangeRequest('Wie kann ich meine Lieferadresse ändern?'), true);
    assert.equal(isOrderAddressChangeRequest('Đơn hàng #1001 đang ở trạng thái nào?'), false);
});

test('creates a prefilled transient form only for an eligible, owned order', () => {
    const form = buildOrderAddressFormPayload('getGuestOrderDetails', {
        status: 'success',
        order: {
            order_number: '000001001',
            address_change_allowed: true,
            billing_address: {
                firstname: 'Ada',
                lastname: 'Lovelace',
                street: ['1 Example Street'],
                country_id: 'DE',
                private_note: 'must not be sent to the browser form'
            },
            shipping_address: {
                firstname: 'Ada',
                lastname: 'Lovelace',
                street: ['2 Delivery Road'],
                country_id: 'DE'
            },
            address_form: {
                fields: [
                    { code: 'firstname', label: 'First Name', input_type: 'text', required: true },
                    { code: 'postcode', label: 'Zip/Postal Code', input_type: 'text', required: false },
                    { code: 'email', label: 'Email', input_type: 'text', required: true }
                ],
                countries: [{ value: 'de', label: 'Germany', is_zip_required: false }],
                regions: {
                    US: [{ id: 12, code: 'CA', name: 'California' }]
                }
            }
        }
    }, { sessionId: 'guest-session-1', conversationId: 21, tokenSecret: TOKEN_SECRET });

    assert.equal(form.access_scope, 'guest');
    assert.match(form.form_id, /^order-address-/);
    assert.ok(form.expires_at > form.created_at);
    assert.equal(form.address_type, 'shipping');
    assert.deepEqual(form.address_types, ['billing', 'shipping']);
    assert.equal(form.addresses.shipping.street[0], '2 Delivery Road');
    assert.equal('private_note' in form.addresses.billing, false);
    assert.deepEqual(form.fields, [
        { code: 'firstname', label: 'First Name', input_type: 'text', required: true, line_count: 1 },
        { code: 'postcode', label: 'Zip/Postal Code', input_type: 'text', required: false, line_count: 1 }
    ]);
    assert.deepEqual(form.countries, [{
        value: 'DE',
        label: 'Germany',
        is_region_required: false,
        is_zip_required: false
    }]);
    assert.deepEqual(form.regions, { US: [{ id: 12, code: 'CA', name: 'California' }] });
    assert.equal(buildOrderAddressFormPayload('getGuestOrderDetails', {
        status: 'success',
        order: { order_number: '000001001', address_change_allowed: false }
    }), null);
});

test('keeps a guest address form at fifteen minutes even when email access lasts longer', () => {
    const before = Date.now();
    const accessExpiresAt = Date.now() + (23 * 60 * 60 * 1000);
    const form = buildOrderAddressFormPayload('getGuestOrderDetails', {
        status: 'success',
        order: {
            order_number: '000001002',
            address_change_allowed: true,
            shipping_address: { firstname: 'Ada', country_id: 'DE' },
            address_form: {
                fields: [{ code: 'firstname', label: 'First name', input_type: 'text', required: true }],
                countries: [{ value: 'DE', label: 'Germany' }],
                regions: {}
            }
        }
    }, {
        accessExpiresAt,
        sessionId: 'guest-session-1',
        conversationId: 21,
        tokenSecret: TOKEN_SECRET
    });

    assert.ok(form.expires_at >= before + 15 * 60_000);
    assert.ok(form.expires_at <= Date.now() + 15 * 60_000);
});

test('keeps a bounded address snapshot for history without retaining checkout email', () => {
    const snapshot = normalizeOrderAddressFormPart({
        type: 'order_address_form',
        form_id: 'address-history-1',
        created_at: Date.now(),
        expires_at: Date.now() + 60_000,
        access_scope: 'customer',
        order_number: '000001001',
        address_types: ['shipping'],
        address_type: 'shipping',
        addresses: {
            shipping: {
                firstname: 'Ada',
                country_id: ' de ',
                email: 'ada@example.com'
            }
        },
        fields: [{ code: 'firstname', label: 'First name', required: true }],
        countries: [{ value: 'de', label: 'Germany' }],
        regions: {}
    });

    assert.equal(snapshot.form_id, 'address-history-1');
    assert.equal(snapshot.addresses.shipping.country_id, 'DE');
    assert.equal('email' in snapshot.addresses.shipping, false);
    assert.deepEqual(snapshot.address_types, ['shipping']);
    assert.equal(normalizeOrderAddressFormPart({ form_id: 'missing-order' }), null);
});

test('redacts expired history address values while retaining the blank form schema', () => {
    const snapshot = normalizeOrderAddressFormPart({
        type: 'order_address_form',
        form_id: 'expired-address-history-1',
        created_at: 100,
        expires_at: 200,
        order_number: '000001001',
        address_types: ['shipping'],
        address_type: 'shipping',
        addresses: { shipping: { firstname: 'Ada', country_id: 'DE' } },
        fields: [{ code: 'firstname', label: 'First name', required: true }],
        countries: [{ value: 'DE', label: 'Germany' }],
        regions: {}
    });

    assert.deepEqual(snapshot.addresses, { shipping: {} });
    assert.deepEqual(snapshot.address_types, ['shipping']);
    assert.equal(snapshot.fields[0].code, 'firstname');
});
