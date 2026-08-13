import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createGeminiFunctionResponsePart,
    normalizeGeminiModelPart
} from '../services/orchestration/gemini-orchestrator.js';

test('wraps Magento tool output in a Gemini functionResponse Part', () => {
    const result = createGeminiFunctionResponsePart('searchProducts', {
        products_found: 1
    });

    assert.deepEqual(result, {
        functionResponse: {
            name: 'searchProducts',
            response: {
                content: {
                    products_found: 1
                }
            }
        }
    });
    assert.equal(Object.hasOwn(result, 'name'), false);
    assert.equal(Object.hasOwn(result, 'response'), false);
});

test('normalizes Gemini function calls before retaining them in the next request', () => {
    assert.deepEqual(
        normalizeGeminiModelPart({
            functionCall: { name: 'handoffToHuman', args: { category: 'order' } },
            name: 'handoffToHuman',
            id: 'provider-call-id',
            thoughtSignature: 'sig'
        }),
        {
            functionCall: { name: 'handoffToHuman', args: { category: 'order' } },
            thoughtSignature: 'sig'
        }
    );
    assert.deepEqual(
        normalizeGeminiModelPart({ name: 'invalid-only-field', id: 'call-id' }),
        null
    );
});
