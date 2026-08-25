import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFallbackMessage,
    createProviderNeutralToolFlow
} from '../services/orchestration/provider-neutral-tool-flow.js';
import {
    FINAL_SYNTHESIS_INSTRUCTION,
    isFinalSynthesisTurn
} from '../services/orchestration/tool-rounds.js';
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

test('defers category discovery for a product request until a product search has run', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Muéstrame artículos de esta categoría.' }
    });

    const result = await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery',
            responseLanguage: 'es-MX',
            responseLanguageEvidence: ['Muéstrame', 'artículos'],
            activityPresentation: {
                language: 'es-MX',
                runningLabel: 'Revisando categorías de productos',
                completedLabel: 'Categorías de productos revisadas',
                failedLabel: 'No se pudieron revisar las categorías',
                runningSummary: 'Procesando durante {duration}',
                completedSummary: 'Proceso completado en {duration}'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'catalog_product_search_required');
    assert.match(result.modelContext.instruction, /call searchProducts first/i);
    assert.deepEqual(frames, []);
});

test('does not execute a product search that omits localized action metadata', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Cửa hàng có sản phẩm màu đen không?' }
    });

    const result = await flow.execute({
        id: 'missing-product-activity',
        name: 'searchProducts',
        args: {
            query: 'áo màu đen',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['cửa hàng có']
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'activity_presentation_required');
    assert.equal(frames.some(frame => frame.type === 'tool_activity'), false);
});

test('reserves one tool-free synthesis turn after the tool-round budget', () => {
    assert.equal(isFinalSynthesisTurn(7, 8), false);
    assert.equal(isFinalSynthesisTurn(8, 8), true);
    assert.equal(isFinalSynthesisTurn(9, 8), false);
});

test('final synthesis forbids plan-only customer prose after tools complete', () => {
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /Tool execution is complete/i);
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /Do not say that you will check, search, look up, refine, or inspect/i);
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /shopper\'s language/i);
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

test('does not mark an image SVG fallback as completed before an image exists', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: '9router',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Tạo hình ảnh chú chó.' },
        config: {
            provider: '9router',
            api_key: 'test-key',
            api_format: 'openai-chat-completions',
            model: 'chat-only',
            models: [{ id: 'chat-only', capabilities: { image_generation: true } }],
            image_generation: { enabled: true }
        }
    });
    const presentation = {
        language: 'vi',
        runningLabel: 'Đang tạo hình ảnh chú chó',
        completedLabel: 'Đã hoàn thành tạo hình ảnh chú chó',
        failedLabel: 'Không thể tạo hình ảnh chú chó',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}'
    };

    const result = await flow.execute({
        id: 'native-image-attempt',
        name: 'generateImage',
        args: { prompt: 'Một chú chó dễ thương', activityPresentation: presentation }
    });

    assert.equal(result.outcome.content.status, 'svg_fallback_required');
    assert.deepEqual(
        frames.filter(frame => frame.type === 'tool_activity').map(frame => [frame.state, frame.label]),
        [['running', 'Đang tạo hình ảnh chú chó']]
    );

    // A provider that fails to perform the invisible SVG retry must not leave
    // a success label behind. A successful retry reuses this action key and
    // replaces the deferred outcome before this terminal flush.
    assert.equal(flow.completePendingActivity(), true);
    assert.deepEqual(
        frames.filter(frame => frame.type === 'tool_activity').map(frame => [frame.state, frame.label]),
        [
            ['running', 'Đang tạo hình ảnh chú chó'],
            ['failed', 'Không thể tạo hình ảnh chú chó']
        ]
    );
});

test('uses model-localized activity labels without passing presentation metadata to commerce', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Muéstrame una camiseta.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });

    const result = await flow.execute({
        id: 'localized-cart-action',
        name: 'addToCart',
        args: {
            sku: 'SHIRT-1',
            activityPresentation: {
                language: 'es-MX',
                runningLabel: 'Actualizando tu carrito',
                completedLabel: 'Carrito actualizado',
                failedLabel: 'No se pudo actualizar el carrito',
                runningSummary: 'Procesando durante {duration}',
                completedSummary: 'Proceso completado en {duration}'
            }
        }
    });

    let activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(activities.map(({ state, label, language, turn_summary }) => ({ state, label, language, turn_summary })), [
        {
            state: 'running',
            label: 'Actualizando tu carrito',
            language: 'es-MX',
            turn_summary: 'Procesando durante {duration}'
        }
    ]);

    // A completed tool result remains the active action while the model is
    // deciding whether it needs another tool. The gateway exposes completion
    // only when the next action begins or this turn reaches its terminal frame.
    assert.equal(flow.completePendingActivity(), true);
    activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(activities.map(({ state, label, language, turn_summary }) => ({ state, label, language, turn_summary })), [
        {
            state: 'running',
            label: 'Actualizando tu carrito',
            language: 'es-MX',
            turn_summary: 'Procesando durante {duration}'
        },
        {
            state: 'completed',
            label: 'Carrito actualizado',
            language: 'es-MX',
            turn_summary: 'Proceso completado en {duration}'
        }
    ]);
    assert.equal(Object.hasOwn(result.outcome, 'activityPresentation'), false);
});

test('completes action A only when the next serial action starts', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Add two distinct products to my cart.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });
    const presentation = {
        language: 'en',
        runningLabel: 'Updating your cart',
        completedLabel: 'Cart updated',
        failedLabel: 'Could not update your cart',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };

    await flow.execute({
        id: 'action-a',
        name: 'addToCart',
        args: { sku: 'FIRST-SKU', activityPresentation: presentation }
    });
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running']
    ]);

    await flow.execute({
        id: 'action-b',
        name: 'addToCart',
        args: { sku: 'SECOND-SKU', activityPresentation: presentation }
    });
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running'],
        ['tool-action-a', 'completed'],
        ['tool-action-b', 'running']
    ]);

    flow.completePendingActivity();
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running'],
        ['tool-action-a', 'completed'],
        ['tool-action-b', 'running'],
        ['tool-action-b', 'completed']
    ]);
});

test('blocks a repeated semantic operation before it can create a second action', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Add the same product.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });
    const firstPresentation = {
        language: 'en',
        runningLabel: 'Updating cart',
        completedLabel: 'Cart updated',
        failedLabel: 'Cart update failed',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };
    const secondPresentation = {
        language: 'vi',
        runningLabel: 'Đang cập nhật giỏ hàng',
        completedLabel: 'Đã cập nhật giỏ hàng',
        failedLabel: 'Không thể cập nhật giỏ hàng',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}'
    };

    const first = await flow.execute({
        id: 'cart-first',
        name: 'addToCart',
        args: { sku: 'SAME-SKU', responseLanguage: 'en', activityPresentation: firstPresentation }
    });
    const repeated = await flow.execute({
        id: 'cart-second',
        name: 'addToCart',
        args: { sku: 'SAME-SKU', responseLanguage: 'vi', activityPresentation: secondPresentation }
    });

    const activitiesBeforeFinalization = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(
        activitiesBeforeFinalization.map(frame => [frame.activity_id, frame.state]),
        [
            ['tool-cart-first', 'running']
        ]
    );
    assert.equal(first.blocked, false);
    assert.equal(repeated.blocked, true);
    assert.equal(repeated.outcome.content.reason, 'duplicate_tool_call');

    flow.completePendingActivity();
    const activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(
        activities.map(frame => [frame.activity_id, frame.state]),
        [
            ['tool-cart-first', 'running'],
            ['tool-cart-first', 'completed']
        ]
    );
    assert.equal(activities[1].continuation_key, activities[0].continuation_key);
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
