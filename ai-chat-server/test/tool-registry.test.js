import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TOOL_DEFINITIONS,
    geminiToolDefinitions,
    openAiToolDefinitions,
    toolDefinitionsForProvider,
    toolPolicy
} from '../services/tools/tool-registry.js';

test('keeps canonical tool names unique and provider schemas derived from one registry', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(openAiToolDefinitions().length, 23);
    assert.equal(geminiToolDefinitions()[0].functionDeclarations.length, 23);
    for (const provider of ['gemini', 'openai', 'cockpit', 'openrouter', '9router']) {
        assert.equal(toolDefinitionsForProvider(provider).length, 23, provider);
    }
    for (const definition of TOOL_DEFINITIONS) {
        const activity = definition.parameters.properties.activityPresentation;
        assert.ok(activity, `${definition.name} includes activity presentation`);
        assert.equal(definition.parameters.required.includes('activityPresentation'), true, definition.name);
        const expectedActivityFields = [
            'language',
            'runningLabel',
            'completedLabel',
            'failedLabel',
            'runningSummary',
            'completedSummary'
        ];
        if (definition.name === 'searchProducts') expectedActivityFields.push('searchScope');
        assert.deepEqual(activity.required, expectedActivityFields);
    }
    const categoryLookup = TOOL_DEFINITIONS.find(definition => definition.name === 'listCategories');
    assert.deepEqual(categoryLookup.parameters.properties.lookupPurpose.enum, [
        'product_discovery',
        'taxonomy_question'
    ]);
    assert.equal(categoryLookup.parameters.required.includes('lookupPurpose'), true);
    assert.ok(categoryLookup.parameters.properties.requiresVariantAttribute);

    const productSearch = TOOL_DEFINITIONS.find(definition => definition.name === 'searchProducts');
    assert.ok(productSearch.parameters.properties.requiredVariantOptionValues);
});

test('marks destructive and verified tools explicitly', () => {
    assert.equal(toolPolicy('cancelOrder').risk, 'destructive');
    assert.equal(toolPolicy('getGuestOrders').requiresVerification, true);
    assert.equal(toolPolicy('getCustomerAddresses').requiresCustomer, true);
});

test('does not expose image generation to a model whose image capability is off', () => {
    const tools = openAiToolDefinitions('openai', {
        image_generation: { available: false }
    });
    assert.equal(tools.some((tool) => tool.function.name === 'generateImage'), false);
    assert.equal(tools.some((tool) => tool.function.name === 'searchProducts'), true);
});
