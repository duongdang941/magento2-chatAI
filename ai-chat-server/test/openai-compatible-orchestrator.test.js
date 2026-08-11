import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFallbackMessage,
    buildBaseUrlCandidates,
    formatProviderError,
    isBlockingToolFailure,
    isRetryableProviderError,
    resolveProviderConfig
} from '../services/openai-compatible-orchestrator.js';
import {
    GUEST_ORDER_AGENT_GUIDANCE,
    guestOrderAccessInstruction
} from '../services/guest-order-access-guidance.js';
import {
    CATALOG_AGENT_GUIDANCE,
    MAX_CATALOG_TOOL_ROUNDS
} from '../services/catalog-agent-guidance.js';
import { RESPONSE_LANGUAGE_AGENT_GUIDANCE } from '../services/response-language-guidance.js';
import {
    normalizeAvailabilityArguments,
    normalizeAddToCartArguments,
    normalizeRemoveFromCartArguments,
    normalizeSearchArguments
} from '../services/catalog-tool-arguments.js';
import { normalizeCustomerAddressArguments } from '../services/customer-order-tool-arguments.js';

test('buildBaseUrlCandidates always includes the public 9router endpoint', () => {
    const originalBase = process.env.NINE_ROUTER_BASE_URL;
    const originalFallback = process.env.NINE_ROUTER_FALLBACK_BASE_URL;

    try {
        process.env.NINE_ROUTER_BASE_URL = 'https://aud4eq.tailabefe9.ts.net/v1';
        delete process.env.NINE_ROUTER_FALLBACK_BASE_URL;

        assert.deepEqual(
            buildBaseUrlCandidates({
                base_url: 'https://aud4eq.tailabefe9.ts.net/v1'
            }),
            [
                'https://aud4eq.tailabefe9.ts.net/v1',
                'https://raud4eq.9router.com/v1'
            ]
        );
    } finally {
        if (originalBase === undefined) {
            delete process.env.NINE_ROUTER_BASE_URL;
        } else {
            process.env.NINE_ROUTER_BASE_URL = originalBase;
        }

        if (originalFallback === undefined) {
            delete process.env.NINE_ROUTER_FALLBACK_BASE_URL;
        } else {
            process.env.NINE_ROUTER_FALLBACK_BASE_URL = originalFallback;
        }
    }
});

test('keeps a configurable package value separate from the cart-line quantity', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({
            sku: 'N054.A8B47',
            qty: 1,
            selectedOptions: { paketpreis: '500 Stk.' }
        }),
        {
            sku: 'N054.A8B47',
            qty: 1,
            cartTarget: 'checkout',
            selectedOptions: { paketpreis: '500 Stk.' }
        }
    );
});

test('uses Quote Cart only when the tool explicitly requests it', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'QUOTE-1', qty: 2, cartTarget: 'quote' }),
        { sku: 'QUOTE-1', qty: 2, cartTarget: 'quote' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CART-1', qty: 2, cartTarget: 'unexpected-value' }),
        { sku: 'CART-1', qty: 2, cartTarget: 'checkout' }
    );
});

test('lets Magento choose the default sale quantity when the shopper omitted quantity', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50' }, 'Thêm sản phẩm này vào giỏ hàng'),
        { sku: 'CARTON-50', qty: 1, useDefaultQty: true, cartTarget: 'checkout' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 1 }, 'Thêm sản phẩm này vào giỏ hàng'),
        { sku: 'CARTON-50', qty: 1, useDefaultQty: true, cartTarget: 'checkout' }
    );
});

test('preserves a shopper-explicit quantity for Magento validation', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 50 }, 'Thêm 50 sản phẩm này'),
        { sku: 'CARTON-50', qty: 50, cartTarget: 'checkout' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 1 }, 'Thêm 1 sản phẩm này'),
        { sku: 'CARTON-50', qty: 1, cartTarget: 'checkout' }
    );
});

test('normalizes product removal to the correct storefront cart', () => {
    assert.deepEqual(
        normalizeRemoveFromCartArguments({ sku: ' REMOVE-1 ', cartTarget: 'quote' }),
        { action: 'remove', sku: 'REMOVE-1', cartTarget: 'quote' }
    );
    assert.deepEqual(
        normalizeRemoveFromCartArguments({ sku: 'REMOVE-2', cartTarget: 'unexpected-value' }),
        { action: 'remove', sku: 'REMOVE-2', cartTarget: 'checkout' }
    );
});

test('normalizes account address updates without accepting customer identity', () => {
    assert.deepEqual(normalizeCustomerAddressArguments({
        customerId: 999,
        addressType: 'shipping',
        address: {
            firstname: ' Ada ',
            country_id: 'de',
            street: [' First Street ', ' Apt 2 ']
        }
    }), {
        addressType: 'shipping',
        address: {
            firstname: 'Ada',
            country_id: 'DE',
            street: ['First Street', 'Apt 2']
        }
    });
});

test('formatProviderError exposes 9router HTTP failures clearly', () => {
    assert.equal(
        formatProviderError(new Error('Base URL https://aud4eq.tailabefe9.ts.net/v1 returned HTTP 502')),
        '9router endpoint đang trả về HTTP 502. Hãy kiểm tra base_url public/tailnet trong cấu hình.'
    );
});

test('retries only transient provider failures before any stream output', () => {
    assert.equal(isRetryableProviderError({ status: 504 }), true);
    assert.equal(isRetryableProviderError({ code: 'PROVIDER_STREAM_TIMEOUT' }), true);
    assert.equal(isRetryableProviderError(new Error('upstream timed out after 1m0s')), true);
    assert.equal(isRetryableProviderError({ status: 401 }), false);
});

test('does not abort normal chat when native Web Search is unavailable', () => {
    assert.equal(isBlockingToolFailure({ status: 'unavailable', reason: 'provider_web_search_unavailable' }), false);
    assert.equal(isBlockingToolFailure({ status: 'error', message: 'Provider failed' }), true);
    assert.equal(isBlockingToolFailure({ error: 'Network failed' }), true);

    assert.match(
        buildFallbackMessage(
            { name: 'searchWeb', content: { status: 'unavailable' } },
            false,
            '',
            false,
            'Cho toi biet hom nay gia vang Viet Nam la bao nhieu'
        ),
        /không hỗ trợ tìm kiếm web/i
    );
});

test('configures a direct OpenAI adapter without Gemini fallback', () => {
    const config = resolveProviderConfig('openai', {
        api_key: 'test-openai-key',
        model: 'gpt-4.1-mini'
    });

    assert.equal(config.label, 'OpenAI');
    assert.equal(config.apiKey, 'test-openai-key');
    assert.equal(config.model, 'gpt-4.1-mini');
    assert.deepEqual(config.candidates, ['https://api.openai.com/v1']);
});

test('tells the provider when guest order access is already verified', () => {
    const instruction = guestOrderAccessInstruction(null, {
        token: 'a'.repeat(64),
        email: 'guest@example.test',
        sessionId: 'b'.repeat(64)
    });

    assert.match(instruction, /already been verified/i);
    assert.match(instruction, /Do not ask the shopper to verify/i);
    const unverifiedInstruction = guestOrderAccessInstruction(null, null);
    assert.match(unverifiedInstruction, /No verified checkout email/i);
    assert.match(unverifiedInstruction, /call the appropriate guest-order tool now/i);
    assert.match(unverifiedInstruction, /guest_access_required/i);
    assert.match(GUEST_ORDER_AGENT_GUIDANCE, /language they use/i);
    assert.match(GUEST_ORDER_AGENT_GUIDANCE, /Do not rely on fixed keywords/i);
});

test('uses a bounded, language-neutral catalogue retrieval protocol', () => {
    assert.equal(MAX_CATALOG_TOOL_ROUNDS, 8);
    assert.match(CATALOG_AGENT_GUIDANCE, /listCategories/);
    assert.match(CATALOG_AGENT_GUIDANCE, /Never repeat an identical call/);
    assert.doesNotMatch(CATALOG_AGENT_GUIDANCE, /hoodie|beachflag|fahnen|vật phẩm/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /unavailable_query_match/);
    assert.match(CATALOG_AGENT_GUIDANCE, /requires a fresh "searchProducts" call in the current turn/i);
    assert.match(RESPONSE_LANGUAGE_AGENT_GUIDANCE, /grammatical\/request words/i);
    assert.match(RESPONSE_LANGUAGE_AGENT_GUIDANCE, /product name.*must never change/i);
});

test('keeps structured price and configurable options out of language-specific query parsing', () => {
    assert.deepEqual(
        normalizeSearchArguments({ query: 'flags', maxPrice: 25 }, 6),
        { query: 'flags', maxPrice: 25, limit: 5, pageSize: 5, page: 1 }
    );
    assert.deepEqual(
        normalizeAvailabilityArguments({
            sku: 'SKU-1',
            selectedOptions: { finish: 'matte', material: 'cotton' }
        }),
        { sku: 'SKU-1', selectedOptions: '{"finish":"matte","material":"cotton"}' }
    );
});
