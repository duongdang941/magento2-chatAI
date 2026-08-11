import test from 'node:test';
import assert from 'node:assert/strict';

import {
    catalogRestUrl,
    catalogScopeCacheIdentity,
    catalogScopeRequestParams,
    normalizeCatalogScope
} from '../services/catalog-scope.js';
import { normalizeSearchArguments } from '../services/catalog-tool-arguments.js';

test('uses only a validated Magento ticket catalogue scope', () => {
    const scope = normalizeCatalogScope({
        store_code: 'parteimitglied_de',
        customer_group_id: 3
    });

    assert.deepEqual(scope, { storeCode: 'parteimitglied_de', customerGroupId: 3 });
    assert.equal(
        catalogRestUrl('http://afd.test/', 'afd-ai/products/search', scope),
        'http://afd.test/rest/parteimitglied_de/V1/afd-ai/products/search'
    );
    assert.deepEqual(catalogScopeRequestParams(scope), { customerGroupId: 3, customerId: 0 });
    assert.deepEqual(catalogScopeCacheIdentity(scope), {
        store_code: 'parteimitglied_de',
        customer_group_id: 3
    });
});

test('rejects malformed scope values and falls back to guest pricing', () => {
    assert.equal(normalizeCatalogScope({ store_code: '../admin', customer_group_id: -1 }), null);
    assert.deepEqual(catalogScopeRequestParams({ storeCode: '<script>', customerGroupId: 99 }), {
        customerGroupId: 0,
        customerId: 0
    });
    assert.equal(
        catalogRestUrl('http://afd.test', 'afd-ai/products/search', null),
        'http://afd.test/rest/V1/afd-ai/products/search'
    );
});

test('drops model-provided scope before the ticket scope is added to a request', () => {
    assert.deepEqual(
        normalizeSearchArguments({
            query: 'poster',
            storeCode: 'other_store',
            customerGroupId: 999,
            website_id: 42
        }),
        { query: 'poster', limit: 5, pageSize: 5, page: 1 }
    );
});
