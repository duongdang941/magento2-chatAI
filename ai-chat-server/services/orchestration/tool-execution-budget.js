function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

function fingerprint(name, args) {
    // Use the same server-owned semantic identity as the customer timeline.
    // Presentation/language evidence and pagination must never turn one
    // product operation into a second visible or executed action.
    return createToolActivityContinuationKey({ toolName: name, args });
}

/**
 * Per-response tool budget shared by all provider adapters.
 * Rejected calls do not consume budget, allowing the model to recover with a
 * different useful call in a later reasoning round.
 */
export function createToolExecutionBudget(config = {}) {
    const maxExecutions = clampInteger(config.max_tool_executions, 15, 1, 30);
    const maxCategoryCalls = clampInteger(config.max_category_calls, 3, 1, 10);
    const blockDuplicates = config.block_duplicate_tool_calls !== false;
    const seen = new Set();
    let executions = 0;
    let categoryCalls = 0;

    return {
        get executions() {
            return executions;
        },
        get exhausted() {
            return executions >= maxExecutions;
        },
        reserve(name, args = {}) {
            if (executions >= maxExecutions) {
                return { allowed: false, reason: 'tool_execution_budget_exhausted' };
            }

            if (name === 'listCategories' && categoryCalls >= maxCategoryCalls) {
                return { allowed: false, reason: 'category_call_budget_exhausted' };
            }

            const callFingerprint = fingerprint(name, args);
            if (blockDuplicates && seen.has(callFingerprint)) {
                return { allowed: false, reason: 'duplicate_tool_call' };
            }

            seen.add(callFingerprint);
            executions += 1;
            if (name === 'listCategories') categoryCalls += 1;
            return { allowed: true };
        }
    };
}

export function toolBudgetMessage(reason) {
    switch (reason) {
        case 'duplicate_tool_call':
            return 'This identical tool call was already completed. Use the existing result or choose a meaningfully different tool call.';
        case 'category_call_budget_exhausted':
            return 'The category lookup budget is exhausted. Use the catalogue evidence already returned and finish the response.';
        case 'tool_execution_budget_exhausted':
        default:
            return 'The tool execution budget is exhausted. Finish the response from the verified evidence already returned.';
    }
}
import { createToolActivityContinuationKey } from './tool-activity.js';
