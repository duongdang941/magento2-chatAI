import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSearchArguments } from '../services/catalog-tool-arguments.js';
import {
    buildCatalogProductsPayload,
    verifyCatalogPageToken
} from '../services/catalog-pagination.js';
import { normalizeMagentoToolResponse } from '../services/catalog-page-loader.js';
import { catalogCoverageInstruction } from '../services/catalog-agent-guidance.js';

test('keeps the catalogue default at five unless the shopper explicitly requests another count', () => {
    assert.deepEqual(
        normalizeSearchArguments({ query: 'poster' }),
        { query: 'poster', limit: 5, pageSize: 5, page: 1 }
    );
    assert.deepEqual(
        normalizeSearchArguments(
            { query: 'poster', limit: 10, limitEvidence: '10' },
            10,
            5,
            'Cho toi 10 san pham'
        ),
        { query: 'poster', limit: 10, pageSize: 10, page: 1 }
    );
    assert.equal(normalizeSearchArguments({ query: 'poster', limit: 100 }).limit, 5);
    assert.deepEqual(
        normalizeSearchArguments({ query: 'poster', directAddOnly: true }),
        { query: 'poster', directAddOnly: true, limit: 5, pageSize: 5, page: 1 }
    );
});

test('rejects a model-selected product count without matching shopper evidence', () => {
    assert.deepEqual(
        normalizeSearchArguments(
            { query: '', categoryId: 102, limit: 8 },
            10,
            5,
            'toi muon mua 1 chiec ao size M va toi cao 1m6'
        ),
        { query: '', categoryId: 102, limit: 5, pageSize: 5, page: 1 }
    );

    assert.deepEqual(
        normalizeSearchArguments(
            { query: 'shirt', limit: 8, limitEvidence: '8' },
            10,
            5,
            'Cho tôi 10 sản phẩm'
        ),
        { query: 'shirt', limit: 5, pageSize: 5, page: 1 }
    );
});

test('accepts a product count copied exactly from the latest shopper message', () => {
    assert.deepEqual(
        normalizeSearchArguments(
            { query: 'shirt', limit: 8, limitEvidence: '8' },
            10,
            5,
            'Cho tôi 8 sản phẩm'
        ),
        { query: 'shirt', limit: 8, pageSize: 8, page: 1 }
    );
});

test('preserves the verified page size when loading a signed continuation', () => {
    assert.deepEqual(
        normalizeSearchArguments({ query: 'shirt', limit: 8, page: 2 }, 10, 8),
        { query: 'shirt', limit: 8, pageSize: 8, page: 2 }
    );
});

test('keeps response language out of Magento search parameters', () => {
    assert.deepEqual(
        normalizeSearchArguments({ query: 'Faltfächel', responseLanguage: 'vi' }),
        { query: 'Faltfächel', limit: 5, pageSize: 5, page: 1 }
    );
});

test('creates a signed next-page token only while the chat card limit permits it', () => {
    const content = {
        data: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, sku: `SKU-${index + 1}` })),
        meta: {
            pagination: {
                total: 23,
                page: 1,
                page_size: 5,
                returned: 5,
                has_more: true,
                next_page: 2
            },
            scope: {
                category_id: 112,
                category_name: 'Plakate & Poster',
                category_url: 'http://example.test/posters.html',
                includes_descendants: true
            }
        }
    };
    const firstPage = buildCatalogProductsPayload(content, { query: '', categoryId: 112, limit: 5 });

    assert.equal(firstPage.payload.total, 23);
    assert.equal(firstPage.payload.pagination.can_load_more, true);
    assert.deepEqual(verifyCatalogPageToken(firstPage.payload.continuation), {
        query: '',
        categoryId: 112,
        page: 2,
        pageSize: 5
    });

    const lastVisiblePage = buildCatalogProductsPayload({
        ...content,
        meta: {
            ...content.meta,
            pagination: { ...content.meta.pagination, page: 4, next_page: 5 }
        }
    }, { query: '', categoryId: 112, limit: 5, page: 4 });

    assert.equal(lastVisiblePage.payload.pagination.can_load_more, false);
    assert.equal(lastVisiblePage.payload.pagination.truncated_for_chat, true);
    assert.equal(lastVisiblePage.payload.continuation, null);
});

test('retains a direct-add-only constraint when loading a later catalogue page', () => {
    const page = buildCatalogProductsPayload({
        data: [{ id: 9, sku: 'SKU-9' }],
        meta: {
            pagination: {
                total: 2,
                page: 1,
                page_size: 1,
                returned: 1,
                has_more: true,
                next_page: 2
            },
            scope: { direct_add_only: true }
        }
    }, { query: 'poster', directAddOnly: true, limit: 1 });

    assert.equal(page.payload.direct_add_only, true);
    assert.deepEqual(verifyCatalogPageToken(page.payload.continuation), {
        query: 'poster',
        categoryId: 0,
        page: 2,
        pageSize: 1,
        directAddOnly: true
    });
});

test('never exposes more structured items than the bounded page size', () => {
    const page = buildCatalogProductsPayload({
        data: Array.from({ length: 31 }, (_, index) => ({ id: index + 1 })),
        meta: {
            pagination: {
                total: 31,
                page: 1,
                page_size: 5,
                returned: 31,
                has_more: true,
                next_page: 2
            }
        }
    }, { query: 'poster', limit: 5 });

    assert.equal(page.items.length, 5);
    assert.equal(page.payload.items.length, 5);
    assert.equal(page.payload.product_ids.length, 5);
    assert.equal(page.payload.pagination.returned, 5);
    assert.equal(page.payload.total, 31);
    assert.deepEqual(page.payload.coverage, {
        shown: 5,
        total: 31,
        remaining: 26,
        complete: false
    });
    assert.equal(page.payload.contract_version, 2);
});

test('requires non-exhaustive prose when only the first catalogue page is visible', () => {
    const instruction = catalogCoverageInstruction({
        total: 8,
        returned: 5,
        has_more: true
    });

    assert.match(instruction, /exactly 5 of 8/i);
    assert.match(instruction, /must not imply/i);
    assert.match(instruction, /shopper's response language/i);
});

test('normalizes Magento Web API positional metadata into named pagination fields', () => {
    const response = normalizeMagentoToolResponse({
        data: [],
        meta: [
            '{"total":11,"page":1,"page_size":5,"returned":5,"has_more":true,"next_page":2}',
            '{"category_id":112,"category_name":"Plakate & Poster","category_url":"https://example.test/posters","includes_descendants":true}'
        ]
    });

    assert.deepEqual(response.meta, {
        pagination: {
            total: 11,
            page: 1,
            page_size: 5,
            returned: 5,
            has_more: true,
            next_page: 2
        },
        scope: {
            category_id: 112,
            category_name: 'Plakate & Poster',
            category_url: 'https://example.test/posters',
            includes_descendants: true
        }
    });
});
