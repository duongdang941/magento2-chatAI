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

test('blocks duplicate calls using one semantic operation key', () => {
    const budget = createToolExecutionBudget({
        max_tool_executions: 10,
        max_category_calls: 3,
        block_duplicate_tool_calls: true
    });

    assert.equal(budget.reserve('searchProducts', {
        query: ' Cờ ',
        page: 1,
        responseLanguage: 'vi',
        responseLanguageEvidence: ['cửa hàng có'],
        activityPresentation: { runningLabel: 'Đang tìm sản phẩm' }
    }).allowed, true);
    assert.deepEqual(budget.reserve('searchProducts', {
        query: 'cờ',
        page: 2,
        responseLanguage: 'en',
        responseLanguageEvidence: ['do you have'],
        activityPresentation: { runningLabel: 'Searching products' }
    }), {
        allowed: false,
        reason: 'duplicate_tool_call'
    });
    assert.equal(budget.executions, 1);
});

test('admits an SVG fallback as a new execution without creating a second visible image action', () => {
    const budget = createToolExecutionBudget({
        max_tool_executions: 10,
        max_category_calls: 3,
        block_duplicate_tool_calls: true
    });
    const nativeAttempt = { prompt: 'Một bức ảnh chú chó dễ thương' };
    const svgFallback = {
        ...nativeAttempt,
        svg_content: '<svg viewBox="0 0 1 1"><circle cx=".5" cy=".5" r=".5" /></svg>'
    };

    assert.equal(budget.reserve('generateImage', nativeAttempt).allowed, true);
    assert.equal(budget.reserve('generateImage', svgFallback).allowed, true);
    assert.deepEqual(budget.reserve('generateImage', svgFallback), {
        allowed: false,
        reason: 'duplicate_tool_call'
    });
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
