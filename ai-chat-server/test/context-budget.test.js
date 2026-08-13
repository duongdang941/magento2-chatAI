import test from 'node:test';
import assert from 'node:assert/strict';

import {
    contextBytes,
    estimateContextTokens,
    fitHistoryToBudget
} from '../services/orchestration/context-budget.js';

test('retains newest history first within the configured token budget', () => {
    const history = [
        { role: 'user', parts: [{ text: 'old '.repeat(800) }] },
        { role: 'model', parts: [{ text: 'middle '.repeat(300) }] },
        { role: 'user', parts: [{ text: 'latest shopper constraint' }] }
    ];

    const fitted = fitHistoryToBudget(history, { maxMessages: 3, maxTokens: 512 });

    assert.equal(fitted.at(-1).parts[0].text, 'latest shopper constraint');
    assert.ok(contextBytes(fitted) <= (512 * 4) + 8);
    assert.ok(fitted.length < history.length);
});

test('compacts one oversized newest message without splitting unicode', () => {
    const fitted = fitHistoryToBudget([
        { role: 'user', parts: [{ text: `begin-${'áo🧥'.repeat(2000)}-important-sku-SKU-9` }] }
    ], { maxMessages: 4, maxTokens: 512 });

    const text = fitted[0].parts[0].text;
    assert.match(text, /^begin-/);
    assert.match(text, /SKU-9$/);
    assert.doesNotMatch(text, /�/);
    assert.ok(estimateContextTokens(fitted) <= 514);
});
