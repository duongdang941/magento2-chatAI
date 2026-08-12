import test from 'node:test';
import assert from 'node:assert/strict';

import {
    coalesceProductParts,
    createCatalogToolPresentation,
    emitProductPresentation,
    replaceProductPart
} from '../services/catalog/product-presentation.js';

function catalogueResult(ids, { directAddOnly = false } = {}) {
    return createCatalogToolPresentation({
        data: ids.map(id => ({ id, name: `Product ${id}` })),
        html: `<div class="afd-ai-chat__product-grid" data-result="${directAddOnly ? 'direct' : 'broad'}"></div>`,
        meta: {
            pagination: {
                total: ids.length,
                page: 1,
                page_size: 5,
                returned: ids.length,
                has_more: ids.length > 5,
                next_page: ids.length > 5 ? 2 : null
            },
            scope: { direct_add_only: directAddOnly }
        }
    }, { query: 'poster', limit: 5, directAddOnly });
}

test('retains only the final product presentation in an assistant turn', () => {
    const direct = catalogueResult([1, 2, 3, 4], { directAddOnly: true });
    const broad = catalogueResult([1, 2, 3, 4, 5, 6, 7]);
    const parts = [{ type: 'text', raw: 'Final answer' }];

    replaceProductPart(parts, { type: 'products', payload: direct.event.products });
    replaceProductPart(parts, { type: 'products', payload: broad.event.products });

    assert.equal(parts.filter(part => part.type === 'products').length, 1);
    assert.deepEqual(parts.at(-1).payload.product_ids, [1, 2, 3, 4, 5]);
    assert.equal(Boolean(parts.at(-1).payload.direct_add_only), false);
});

test('coalesces legacy assistant payloads with multiple product grids', () => {
    const parts = [
        { type: 'products', payload: { product_ids: [1] } },
        { type: 'text', raw: 'Answer' },
        { type: 'products', payload: { product_ids: [2] } }
    ];
    const normalized = coalesceProductParts(parts);

    assert.deepEqual(normalized, [parts[1], parts[2]]);
});

test('emits the selected presentation as one products_html event', () => {
    const sent = [];
    const ws = { send: payload => sent.push(JSON.parse(payload)) };
    const presentation = catalogueResult([1, 2, 3]).event;

    assert.equal(emitProductPresentation(ws, presentation), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'products_html');
    assert.equal(sent[0].products.items.length, 3);
});
