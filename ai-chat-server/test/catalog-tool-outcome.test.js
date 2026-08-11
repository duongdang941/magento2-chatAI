import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isResolvedCatalogIdentity,
    isUnavailableQueryMatch,
    isTerminalCatalogMiss,
    resolvedCatalogIdentityBlock,
    unavailableCatalogMessage
} from '../services/catalog-tool-outcome.js';

test('recognizes only the authoritative unavailable product sentinel', () => {
    assert.equal(isUnavailableQueryMatch({
        meta: { scope: { unavailable_query_match: true } }
    }), true);
    assert.equal(isUnavailableQueryMatch({
        meta: { scope: { unavailable_query_match: false } }
    }), false);
    assert.equal(isUnavailableQueryMatch({ data: [] }), false);
});

test('recognizes an exact identity miss as a terminal catalogue outcome', () => {
    assert.equal(isTerminalCatalogMiss({ meta: { scope: { exact_query_miss: true } } }), true);
    assert.equal(isTerminalCatalogMiss({ meta: { scope: { exact_query_miss: false } } }), false);
});

test('renders an immediate terminal catalogue message in the model-selected language', () => {
    assert.equal(
        unavailableCatalogMessage({
            query: 'Faltfächer "Sonnenaufgang"',
            responseLanguage: 'vi-VN'
        }),
        'Hiện sản phẩm “Faltfächer "Sonnenaufgang"” không có trong danh mục đang được bán.'
    );
    assert.equal(
        unavailableCatalogMessage({
            query: 'Faltfächer "Sonnenaufgang"',
            responseLanguage: 'de-DE'
        }),
        'Das Produkt “Faltfächer "Sonnenaufgang"” ist derzeit nicht im aktiven Sortiment verfügbar.'
    );
});

test('sanitizes the tool-provided catalogue label before rendering it', () => {
    const message = unavailableCatalogMessage({
        query: '<script>*unsafe*</script>',
        responseLanguage: 'en'
    });

    assert.equal(message.includes('<'), false);
    assert.equal(message.includes('*'), false);
});

test('recognizes a single exact normalized product identity as sufficient evidence', () => {
    assert.equal(isResolvedCatalogIdentity({
        name: 'searchProducts',
        query: 'Strickmütze "AfD"',
        content: { data: [{ sku: '022.G104', name: 'Strickmütze "AfD"' }] }
    }), true);
    assert.equal(isResolvedCatalogIdentity({
        name: 'searchProducts',
        query: 'Tase Freiheit',
        content: { data: [{ sku: 'N021.B4012', name: 'Tasse "Freiheit"' }] }
    }), true);
    assert.equal(isResolvedCatalogIdentity({
        name: 'searchProducts',
        query: 'shirt',
        content: { data: [{ sku: 'A' }, { sku: 'B' }] }
    }), false);
    assert.equal(resolvedCatalogIdentityBlock().reason, 'catalog_identity_already_resolved');
});
