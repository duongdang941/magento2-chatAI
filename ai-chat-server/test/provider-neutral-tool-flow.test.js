import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFallbackMessage,
    createProviderNeutralToolFlow
} from '../services/orchestration/provider-neutral-tool-flow.js';
import { CATALOG_AGENT_GUIDANCE } from '../services/catalog/catalog-agent-guidance.js';

test('uses the same initial catalogue policy regardless of provider protocol', () => {
    for (const provider of ['gemini', 'openai', 'cockpit', 'openrouter', '9router']) {
        const flow = createProviderNeutralToolFlow({
            provider,
            currentUserMessage: { text: 'Tôi muốn mua một chiếc áo.' }
        });
        // Tool selection is semantic model work. The shared gateway flow must
        // not infer shopping intent (or force a tool) from the shopper text.
        assert.equal(flow.shouldForceProductSearch(), false, provider);
    }
});

test('requires product-page selection instead of collecting options in chat', () => {
    assert.match(CATALOG_AGENT_GUIDANCE, /must be configured only on its returned product page/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /do not list, ask for, accept, or verify options in chat/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /only when the current Magento result says direct_addable=true/i);
});

test('keeps an unverified human-support reply focused on the verification card', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Toi muon lien he voi nhan vien ho tro' }
    });

    const result = await flow.execute({
        name: 'handoffToHuman',
        args: {}
    });

    assert.equal(result.outcome.content.reason, 'guest_access_required');
    assert.match(result.modelContext.instruction, /complete the verification form below/i);
    assert.match(result.modelContext.instruction, /do not discuss unrelated products/i);
    assert.match(result.modelContext.instruction, /do not ask for the email or code in prose/i);
});

test('keeps an unavailable provider capability non-blocking for normal chat', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Hãy tạo một hình minh hoạ.' }
    });
    const result = await flow.execute({
        id: 'image-call',
        name: 'generateImage',
        args: { prompt: 'A product illustration' }
    });

    assert.equal(result.error, '');
    assert.notEqual(result.outcome.content.status, 'error');
    assert.ok(result.modelContext.instruction || result.modelContext.message);
    assert.match(buildFallbackMessage(), /AI response could not be completed/i);
});

test('explains insufficient stock instead of inventing a product-page option requirement', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Thêm 200 Sonnenschirm vào giỏ hàng.' },
        options: {
            requestBrowserCart: async () => ({
                status: 'requires_customer_action',
                reason: 'insufficient_stock',
                requested_qty: 200,
                sku: '023.F101'
            })
        }
    });

    const result = await flow.execute({
        id: 'stock-limit-call',
        name: 'addToCart',
        args: { sku: '023.F101', qty: 200 }
    });

    assert.equal(result.outcome.content.reason, 'insufficient_stock');
    assert.match(result.modelContext.instruction, /exceeds the currently available salable quantity/i);
    assert.doesNotMatch(result.modelContext.instruction, /needs product-page configuration/i);
});

test('blocks a repeated add-to-cart call after product-page configuration is required', async () => {
    let browserCartRequests = 0;
    const productPageUrl = 'https://afd.test/t-shirt-hellblau-mit-wunsch-aufdruck-1-design.html';
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Thêm áo N022.A00 vào giỏ hàng.' },
        options: {
            requestBrowserCart: async () => {
                browserCartRequests += 1;
                return {
                    status: 'requires_customer_action',
                    reason: 'product_page_required',
                    product: 'T-Shirt mit Wunschaufdruck',
                    sku: 'N022.A00',
                    url: productPageUrl,
                    message: 'Please configure your design on the product page first.'
                };
            }
        }
    });

    const first = await flow.execute({
        id: 'product-page-first-call',
        name: 'addToCart',
        args: { sku: 'N022.A00', qty: 1 }
    });
    const retry = await flow.execute({
        id: 'product-page-retry-call',
        name: 'addToCart',
        args: { sku: 'N022.A00', qty: 1 }
    });

    assert.equal(browserCartRequests, 1);
    assert.equal(first.blocked, false);
    assert.equal(retry.blocked, true);
    assert.equal(retry.outcome.content.status, 'requires_customer_action');
    assert.equal(retry.outcome.content.reason, 'product_page_required');
    assert.equal(retry.outcome.content.sku, 'N022.A00');
    assert.equal(retry.outcome.content.url, productPageUrl);
    assert.equal(retry.outcome.content.blocked, true);
    assert.match(retry.modelContext.instruction, /Do not retry addToCart/i);
    assert.match(retry.modelContext.instruction, /only the returned product URL/i);
});

test('reconciles concurrent tool outcomes in model call order', () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Tìm áo.' }
    });
    const state = flow.reconcile([
        {
            outcome: {
                name: 'searchProducts',
                query: 'shirt',
                content: {
                    data: [{ name: 'Shirt', sku: 'SHIRT-1' }],
                    meta: { pagination: { total: 1 } }
                }
            },
            productPresentation: { type: 'products_html', html: '<div>shirt</div>' }
        },
        {
            outcome: {
                name: 'listCategories',
                content: { data: [] }
            }
        }
    ]);

    assert.equal(state.hasVisibleProducts, true);
    assert.equal(state.lastToolOutcome.name, 'listCategories');
    assert.equal(state.pendingProductPresentation.type, 'products_html');
});
