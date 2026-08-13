import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFallbackMessage,
    createProviderNeutralToolFlow
} from '../services/orchestration/provider-neutral-tool-flow.js';

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
