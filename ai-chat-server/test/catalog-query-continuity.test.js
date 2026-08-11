import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogQueryContinuity } from '../services/catalog-query-continuity.js';

test('keeps a missed product query when narrowing to a category', () => {
    const continuity = createCatalogQueryContinuity();

    const initial = continuity.normalize('searchProducts', {
        query: 'Hose',
        categoryId: 0
    });
    continuity.observe('searchProducts', initial, {
        data: [],
        meta: { pagination: { total: 0 } }
    });

    assert.deepEqual(continuity.normalize('searchProducts', {
        query: '',
        categoryId: 101
    }), {
        query: 'Hose',
        categoryId: 101
    });
});

test('allows a verified leaf category to resolve a shopper-language synonym', () => {
    const continuity = createCatalogQueryContinuity();
    continuity.observe('searchProducts', { query: 'hoodie' }, {
        data: [],
        meta: { pagination: { total: 0 } }
    });
    continuity.observe('listCategories', {}, {
        data: [
            { id: 101, parent_id: 2, product_count: 29 },
            { id: 103, parent_id: 101, product_count: 2 }
        ]
    });

    assert.deepEqual(continuity.normalize('searchProducts', {
        query: 'hoodie',
        categoryId: 103
    }), {
        query: '',
        categoryId: 103
    });
});

test('does not drop a missed query for a broad parent category', () => {
    const continuity = createCatalogQueryContinuity();
    continuity.observe('searchProducts', { query: 'Hose' }, {
        data: [],
        meta: { pagination: { total: 0 } }
    });
    continuity.observe('listCategories', {}, {
        data: [
            { id: 101, parent_id: 2, product_count: 29 },
            { id: 103, parent_id: 101, product_count: 2 }
        ]
    });

    assert.equal(
        continuity.normalize('searchProducts', { query: '', categoryId: 101 }).query,
        'Hose'
    );
});

test('does not rewrite a deliberate first category browse', () => {
    const continuity = createCatalogQueryContinuity();

    assert.deepEqual(continuity.normalize('searchProducts', {
        query: '',
        categoryId: 101
    }), {
        query: '',
        categoryId: 101
    });
});

test('clears the missed query after a successful replacement search', () => {
    const continuity = createCatalogQueryContinuity();
    continuity.observe('searchProducts', { query: 'first query' }, {
        data: [],
        meta: { pagination: { total: 0 } }
    });
    continuity.observe('searchProducts', { query: 'better query' }, {
        data: [{ id: 1 }],
        meta: { pagination: { total: 1 } }
    });

    assert.deepEqual(continuity.normalize('searchProducts', {
        query: '',
        categoryId: 101
    }), {
        query: '',
        categoryId: 101
    });
});

test('does not learn from failed tool responses', () => {
    const continuity = createCatalogQueryContinuity();
    continuity.observe('searchProducts', { query: 'unavailable query' }, {
        error: 'Catalogue unavailable'
    });

    assert.equal(
        continuity.normalize('searchProducts', { query: '', categoryId: 101 }).query,
        ''
    );
});
