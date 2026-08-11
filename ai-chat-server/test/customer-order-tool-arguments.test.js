import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeOrderAddressArguments,
    normalizeOrderDetailsArguments,
    normalizeRecentOrdersArguments
} from '../services/customer-order-tool-arguments.js';

test('bounds the number of customer orders requested from Magento', () => {
    assert.deepEqual(normalizeRecentOrdersArguments({ limit: 99 }), { limit: 10 });
    assert.deepEqual(normalizeRecentOrdersArguments({ limit: 0 }), { limit: 1 });
});

test('accepts only a safe storefront order number', () => {
    assert.deepEqual(normalizeOrderDetailsArguments({ orderNumber: '000000123' }), { orderNumber: '000000123' });
    assert.deepEqual(normalizeOrderDetailsArguments({ orderNumber: '100 OR 1=1' }), { orderNumber: '' });
});

test('normalizes an order-address change without accepting customer identity', () => {
    assert.deepEqual(
        normalizeOrderAddressArguments({
            customerId: 7,
            orderNumber: '000000123',
            addressType: 'shipping',
            address: {
                street: '  123 Main Street\nSuite 4  ',
                prefix: ' Dr. ',
                middlename: '  Maria ',
                suffix: '  PhD ',
                city: '  Berlin ',
                countryId: 'de',
                regionId: '8',
                fax: ' 030 123 ',
                vat_id: ' DE123 '
            }
        }),
        {
            orderNumber: '000000123',
            addressType: 'shipping',
            address: {
                street: ['123 Main Street', 'Suite 4'],
                prefix: 'Dr.',
                middlename: 'Maria',
                suffix: 'PhD',
                city: 'Berlin',
                country_id: 'DE',
                region_id: 8,
                fax: '030 123',
                vat_id: 'DE123'
            }
        }
    );
});
