import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolExecutionBudget } from '../services/orchestration/tool-execution-budget.js';

test('enforces the total execution budget without counting blocked calls', () => {
    const budget = createToolExecutionBudget({
        max_tool_executions: 2,
        max_category_calls: 2,
        block_duplicate_tool_calls: false
    });

    assert.equal(budget.reserve('searchProducts', { query: 'flag' }).allowed, true);
    assert.equal(budget.reserve('getProductAvailability', { sku: 'SKU-1' }).allowed, true);
    assert.deepEqual(budget.reserve('searchProducts', { query: 'poster' }), {
        allowed: false,
        reason: 'tool_execution_budget_exhausted'
    });
    assert.equal(budget.executions, 2);
});

test('blocks duplicate calls using canonical argument order', () => {
    const budget = createToolExecutionBudget({
        max_tool_executions: 10,
        max_category_calls: 3,
        block_duplicate_tool_calls: true
    });

    assert.equal(budget.reserve('searchProducts', { query: 'flag', page: 1 }).allowed, true);
    assert.deepEqual(budget.reserve('searchProducts', { page: 1, query: 'flag' }), {
        allowed: false,
        reason: 'duplicate_tool_call'
    });
    assert.equal(budget.executions, 1);
});

test('limits category discovery independently from useful product tools', () => {
    const budget = createToolExecutionBudget({
        max_tool_executions: 10,
        max_category_calls: 1,
        block_duplicate_tool_calls: false
    });

    assert.equal(budget.reserve('listCategories', { responseLanguage: 'vi' }).allowed, true);
    assert.deepEqual(budget.reserve('listCategories', { responseLanguage: 'de' }), {
        allowed: false,
        reason: 'category_call_budget_exhausted'
    });
    assert.equal(budget.reserve('searchProducts', { query: 'Fächer' }).allowed, true);
});
