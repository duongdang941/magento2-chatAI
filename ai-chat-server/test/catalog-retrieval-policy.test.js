import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createCatalogRetrievalPolicy,
    requiresFreshProductSearch
} from '../services/catalog/catalog-retrieval-policy.js';

test('does not infer a product search from natural language', () => {
    assert.equal(
        requiresFreshProductSearch('Tôi cao 1m6 nặng 70kg và muốn mua một chiếc áo.'),
        false
    );
});

test('uses the same discovery decision for English and German product requests', () => {
    assert.equal(requiresFreshProductSearch('Show me a hoodie to buy.'), false);
    assert.equal(requiresFreshProductSearch('Ich suche eine Jacke zum Kaufen.'), false);
});

test('does not force a new search for category questions or an existing product card', () => {
    assert.equal(requiresFreshProductSearch('Những danh mục nào đang có?'), false);
    assert.equal(requiresFreshProductSearch('Thêm sản phẩm này vào giỏ hàng'), false);
});

test('does not force catalogue search for a negated purchase and support request', () => {
    assert.equal(
        requiresFreshProductSearch('Cảm ơn bạn, tôi không muốn mua sản phẩm nữa, có thể cho tôi liên hệ với người hỗ trợ không'),
        false
    );
    assert.equal(
        requiresFreshProductSearch("I don't want to buy this product anymore. Please connect me with a human."),
        false
    );
});

test('does not force any tool before the model selects it', () => {
    const policy = createCatalogRetrievalPolicy({ shopperMessage: 'Tôi muốn mua áo.' });

    assert.equal(policy.shouldForceProductSearch(), false);
    policy.observeToolCall('listCategories');
    assert.equal(policy.shouldForceProductSearch(), false);
    policy.observeToolCall('searchProducts');
    assert.equal(policy.shouldForceProductSearch(), false);
});
