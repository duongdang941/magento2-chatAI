import test from 'node:test';
import assert from 'node:assert/strict';

import { reduceToolResultForModel } from '../services/orchestration/tool-context-reducer.js';

test('removes UI-only order form metadata while preserving ownership and eligibility facts', () => {
    const raw = {
        status: 'success',
        order: {
            order_number: '100000123',
            status: 'Processing',
            address_change_allowed: false,
            address_change_reason: 'already_shipped',
            items: [{ sku: 'SKU-1', name: 'Jacket', qty_ordered: 1 }],
            address_form: {
                countries: Array.from({ length: 250 }, (_, id) => ({ id, name: `Country ${id}` })),
                required_fields: ['firstname', 'lastname', 'street', 'city']
            }
        },
        instruction: 'Use only the returned order data.'
    };

    const { modelContext, stats } = reduceToolResultForModel('getOrderDetails', raw);

    assert.equal(modelContext.order.order_number, '100000123');
    assert.equal(modelContext.order.address_change_allowed, false);
    assert.equal(modelContext.order.address_change_reason, 'already_shipped');
    assert.equal('address_form' in modelContext.order, false);
    assert.equal(raw.order.address_form.countries.length, 250);
    assert.ok(stats.modelBytes < stats.rawBytes);
});

test('deduplicates product evidence and retains truthful coverage metadata', () => {
    const product = {
        id: 10,
        sku: 'SKU-10',
        name: 'Store Jacket',
        price: '€49.00',
        in_stock: true,
        variant_options: { size: ['S', 'M', 'L'] }
    };
    const raw = {
        products_found: 3,
        total_products: 8,
        pagination: { total: 8, page: 1, page_size: 5, returned: 3, has_more: true, next_page: 2 },
        products: [product, { ...product }, { ...product }],
        instruction: 'Only mention returned products.'
    };

    const { modelContext } = reduceToolResultForModel('searchProducts', raw);

    assert.equal(modelContext.products.length, 1);
    assert.equal(modelContext.total_products, 8);
    assert.equal(modelContext.pagination.has_more, true);
});

test('falls back to the original model payload when reduction cannot improve it', () => {
    const raw = { status: 'success', sku: 'SKU-1' };
    const { modelContext, stats } = reduceToolResultForModel('getProductAvailability', raw);

    assert.deepEqual(modelContext, raw);
    assert.equal(stats.modelBytes, stats.rawBytes);
    assert.equal(stats.strategy, 'passthrough');
});

test('bounds long web excerpts, removes duplicate URLs, and keeps citations', () => {
    const raw = {
        status: 'success',
        sources: [
            { title: 'Source', url: 'https://example.test/a', excerpt: 'fact '.repeat(2000) },
            { title: 'Duplicate', url: 'https://example.test/a', excerpt: 'duplicate' }
        ],
        instruction: 'Cite factual claims.'
    };

    const { modelContext } = reduceToolResultForModel('searchWeb', raw, { maxTokens: 512 });

    assert.equal(modelContext.sources.length, 1);
    assert.equal(modelContext.sources[0].url, 'https://example.test/a');
    assert.ok(modelContext.sources[0].excerpt.length < raw.sources[0].excerpt.length);
    assert.equal(modelContext.instruction, raw.instruction);
});
