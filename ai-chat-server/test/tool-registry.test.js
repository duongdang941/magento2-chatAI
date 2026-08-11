import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TOOL_DEFINITIONS,
    geminiToolDefinitions,
    openAiToolDefinitions,
    toolPolicy
} from '../services/tools/tool-registry.js';

test('keeps canonical tool names unique and provider schemas derived from one registry', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(openAiToolDefinitions().length, 22);
    assert.equal(geminiToolDefinitions()[0].functionDeclarations.length, 13);
});

test('marks destructive and verified tools explicitly', () => {
    assert.equal(toolPolicy('cancelOrder').risk, 'destructive');
    assert.equal(toolPolicy('getGuestOrders').requiresVerification, true);
    assert.equal(toolPolicy('getCustomerAddresses').requiresCustomer, true);
});
