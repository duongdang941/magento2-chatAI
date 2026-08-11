#!/usr/bin/env node

import 'dotenv/config';
import assert from 'node:assert/strict';
import axios from 'axios';

import { createMagentoRequestConfig } from '../services/magento-auth.js';
import { buildLocalGatewayEnvironment } from '../services/local-magento-bootstrap.js';

Object.assign(process.env, buildLocalGatewayEnvironment());
const { getAiConfig } = await import('../services/config-service.js');

const baseUrl = (process.env.MAGENTO_API_URL || 'http://afd.test').replace(/\/+$/, '');
const searchEndpoint = `${baseUrl}/rest/V1/afd-ai/products/search`;
const categoriesEndpoint = `${baseUrl}/rest/V1/afd-ai/categories`;
const magentoOauth = (await getAiConfig()).magento_oauth;
const categories = await loadCategories();
const textileCategory = categoryNamed('Textilien');
const cupCategory = categoryNamed('Tassen');

const cases = [
    {
        name: 'active exact identity',
        params: { query: 'Tasse Freiheit', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.deepEqual(items.map(item => item.sku), ['N021.B4012']);
            assert.equal(scope.exact_query_match, true);
        }
    },
    {
        name: 'active typo identity',
        params: { query: 'Tase Freiheit', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.deepEqual(items.map(item => item.sku), ['N021.B4012']);
            assert.equal(scope.exact_query_match, true);
        }
    },
    {
        name: 'active long-name deletion typo',
        params: { query: 'Luftbalons', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.deepEqual(items.map(item => item.sku), ['021.A403']);
            assert.equal(scope.exact_query_match, true);
        }
    },
    {
        name: 'typo recovery does not depend on model identity flag',
        params: { query: 'Luftbalons', exactIdentity: false },
        verify: ({ items }) => {
            assert.deepEqual(items.map(item => item.sku), ['021.A403']);
        }
    },
    {
        name: 'active long-name duplication typo',
        params: { query: 'Sonenbrille Deutschland im Blick', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.deepEqual(items.map(item => item.sku), ['021.G501']);
            assert.equal(scope.exact_query_match, true);
        }
    },
    {
        name: 'disabled exact identity stays unavailable',
        params: { query: 'Faltfächer Sonnenaufgang', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.equal(items.length, 0);
            assert.ok(scope.unavailable_query_match || scope.exact_query_miss);
        }
    },
    {
        name: 'absent exact identity stays unavailable',
        params: { query: 'Galaxy Mug 9000', exactIdentity: true },
        verify: ({ items, scope }) => {
            assert.equal(items.length, 0);
            assert.equal(scope.exact_query_miss, true);
        }
    },
    {
        name: 'unscoped empty query is rejected safely',
        params: { query: '' },
        verify: ({ items, pagination }) => {
            assert.equal(items.length, 0);
            assert.equal(pagination.total, 0);
        }
    },
    {
        name: 'verified category browse',
        params: { query: '', categoryId: textileCategory.id, limit: 5 },
        verify: ({ items, scope, pagination }) => {
            assert.ok(items.length > 0);
            assert.equal(Number(scope.category_id), textileCategory.id);
            assert.equal(pagination.returned, items.length);
        }
    },
    {
        name: 'structured price range',
        params: {
            query: '',
            categoryId: textileCategory.id,
            minPrice: 20,
            maxPrice: 80,
            limit: 10
        },
        verify: ({ items }) => {
            assert.ok(items.length > 0);
            items.forEach(item => {
                const price = parsePrice(item.price);
                assert.ok(price >= 20 && price <= 80, `price ${price} is outside 20..80`);
            });
        }
    },
    {
        name: 'direct-add filter',
        params: { query: '', categoryId: cupCategory.id, directAddOnly: true, limit: 10 },
        verify: ({ items, scope }) => {
            assert.ok(items.length > 0);
            assert.equal(scope.direct_add_only, true);
            items.forEach(item => assert.equal(item.direct_addable, true));
        }
    },
    {
        name: 'excluded product-name terms',
        params: {
            query: '',
            categoryId: textileCategory.id,
            excludedTerms: JSON.stringify(['T-Shirt']),
            limit: 10
        },
        verify: ({ items, scope }) => {
            assert.ok(items.length > 0);
            assert.deepEqual(scope.excluded_terms, ['T-Shirt']);
            items.forEach(item => assert.doesNotMatch(item.name, /t-shirt/i));
        }
    },
    {
        name: 'server result cap',
        params: { query: '', categoryId: textileCategory.id, limit: 50 },
        verify: ({ items, pagination }) => {
            assert.ok(items.length <= 10);
            assert.equal(pagination.page_size, 10);
        }
    }
];

let passed = 0;
for (const testCase of cases) {
    try {
        const result = await searchProducts(testCase.params);
        assertProductPayload(result, testCase.name);
        await testCase.verify(result);
        passed += 1;
        console.log(`PASS ${testCase.name}`);
    } catch (error) {
        console.error(`FAIL ${testCase.name}: ${error.message || error}`);
    }
}

try {
    await validatePagination();
    passed += 1;
    console.log('PASS deterministic pagination');
} catch (error) {
    console.error(`FAIL deterministic pagination: ${error.message || error}`);
}

console.log(`Shopping contract: ${passed}/${cases.length + 1} passed`);
if (passed !== cases.length + 1) process.exitCode = 1;

async function searchProducts(overrides = {}) {
    const params = {
        query: '',
        limit: 5,
        page: 1,
        categoryId: 0,
        minPrice: 0,
        maxPrice: 0,
        directAddOnly: false,
        exactIdentity: false,
        excludedTerms: '',
        ...overrides
    };
    const requestConfig = createMagentoRequestConfig('GET', searchEndpoint, {
        magentoOauth,
        signParams: params
    });
    const response = await axios.get(searchEndpoint, { ...requestConfig, params });
    const payload = response.data || {};
    const meta = normalizeItems(payload.meta);

    return {
        payload,
        items: normalizeItems(payload.data),
        pagination: meta.find(item => Object.hasOwn(item, 'returned')) || {},
        scope: meta.find(item => Object.hasOwn(item, 'category_id')) || {}
    };
}

async function loadCategories() {
    const requestConfig = createMagentoRequestConfig('GET', categoriesEndpoint, { magentoOauth });
    const response = await axios.get(categoriesEndpoint, requestConfig);
    const items = normalizeItems(response.data?.data);
    assert.ok(items.length > 0, 'category endpoint returned no categories');
    items.forEach(category => {
        assert.ok(Number(category.id) > 0, 'category has no valid ID');
        assert.ok(Number(category.product_count) > 0, `category ${category.name} has no products`);
        assert.ok(isSafeHttpUrl(category.url), `category ${category.name} has an unsafe URL`);
    });
    return items;
}

function categoryNamed(name) {
    const category = categories.find(item => item.name === name);
    assert.ok(category, `required category ${name} is missing from fixture catalogue`);
    return { ...category, id: Number(category.id) };
}

async function validatePagination() {
    const first = await searchProducts({ query: '', categoryId: textileCategory.id, page: 1, limit: 3 });
    const second = await searchProducts({ query: '', categoryId: textileCategory.id, page: 2, limit: 3 });
    assert.equal(first.pagination.page, 1);
    assert.equal(second.pagination.page, 2);
    assert.equal(first.pagination.page_size, 3);
    assert.equal(first.pagination.total, second.pagination.total);
    assert.equal(first.pagination.has_more, true);
    const firstSkus = new Set(first.items.map(item => item.sku));
    second.items.forEach(item => assert.ok(!firstSkus.has(item.sku), `duplicate paged SKU ${item.sku}`));
}

function assertProductPayload(result, label) {
    assert.ok(Array.isArray(result.items), `${label}: data is not an array`);
    assert.ok(Object.hasOwn(result.pagination, 'returned'), `${label}: pagination metadata is missing`);
    assert.equal(result.pagination.returned, result.items.length, `${label}: returned count is inconsistent`);
    result.items.forEach(item => {
        assert.ok(String(item.sku || '').trim(), `${label}: product SKU is missing`);
        assert.ok(String(item.name || '').trim(), `${label}: product name is missing`);
        assert.ok(isSafeHttpUrl(item.url), `${label}: product URL is unsafe`);
        assertNoInternalFixture(item, label);
    });
}

function normalizeItems(values) {
    return (Array.isArray(values) ? values : [])
        .map(value => {
            if (value && typeof value === 'object') return value;
            try {
                return JSON.parse(String(value || ''));
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function parsePrice(value) {
    const normalized = String(value || '').replace(/\s+/g, '').replace(/\./g, '').replace(',', '.');
    const match = normalized.match(/\d+(?:\.\d+)?/);
    assert.ok(match, `could not parse price ${value}`);
    return Number(match[0]);
}

function assertNoInternalFixture(item, label) {
    const haystack = `${item?.name || ''} ${item?.sku || ''}`.toLowerCase();
    assert.doesNotMatch(haystack, /(?:demo produkt|nicht kaufbar|\btest\b|\bdemo\b)/, `${label}: fixture leaked`);
}

function isSafeHttpUrl(value) {
    try {
        return ['http:', 'https:'].includes(new URL(String(value || '')).protocol);
    } catch {
        return false;
    }
}
