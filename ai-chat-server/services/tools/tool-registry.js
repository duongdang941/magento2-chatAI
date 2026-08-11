const addressProperties = Object.freeze({
    firstname: { type: 'string' },
    lastname: { type: 'string' },
    company: { type: 'string' },
    street: { type: 'array', items: { type: 'string' } },
    city: { type: 'string' },
    region: { type: 'string' },
    regionId: { type: 'integer' },
    postcode: { type: 'string' },
    countryId: { type: 'string' },
    telephone: { type: 'string' },
    email: { type: 'string' }
});

const objectSchema = (properties = {}, required = []) => ({
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
});

const tool = (name, description, parameters, policy = {}) => Object.freeze({
    name,
    description,
    parameters,
    policy: Object.freeze({
        risk: policy.risk || 'read',
        requiresCustomer: policy.requiresCustomer === true,
        requiresVerification: policy.requiresVerification === true,
        providers: Object.freeze(policy.providers || ['openai', 'gemini'])
    })
});

export const TOOL_DEFINITIONS = Object.freeze([
    tool('searchProducts', 'Search real Magento products before answering catalogue questions.', objectSchema({
        query: { type: 'string' },
        categoryId: { type: 'integer' },
        limit: { type: 'integer' },
        limitEvidence: { type: 'string' },
        pageSize: { type: 'integer' },
        page: { type: 'integer' },
        minPrice: { type: 'number' },
        maxPrice: { type: 'number' },
        directAddOnly: { type: 'boolean' },
        exactIdentity: { type: 'boolean' },
        excludedTerms: { type: 'array', items: { type: 'string' } },
        responseLanguage: { type: 'string' },
        responseLanguageEvidence: { type: 'array', items: { type: 'string' } }
    }, ['query', 'exactIdentity', 'responseLanguage', 'responseLanguageEvidence'])),
    tool('compareProducts', 'Compare two returned Magento products by exact SKU.', objectSchema({
        sku1: { type: 'string' },
        sku2: { type: 'string' }
    }, ['sku1', 'sku2']), { providers: ['openai'] }),
    tool('getProductAvailability', 'Check live Magento salable quantity for an exact returned SKU.', objectSchema({
        sku: { type: 'string' },
        selectedOptions: { type: 'object', additionalProperties: { type: 'string' } }
    }, ['sku'])),
    tool('listCategories', 'Inspect the real Magento category taxonomy.', objectSchema({
        responseLanguage: { type: 'string' },
        responseLanguageEvidence: { type: 'array', items: { type: 'string' } }
    }, ['responseLanguage', 'responseLanguageEvidence'])),
    tool('addToCart', 'Add a verified product selection using Magento quantity rules to checkout or explicit Quote Cart.', objectSchema({
        sku: { type: 'string' },
        qty: { type: 'integer' },
        cartTarget: { type: 'string', enum: ['checkout', 'quote'] },
        selectedOptions: { type: 'object', additionalProperties: { type: 'string' } }
    }, ['sku']), { risk: 'mutation' }),
    tool('removeFromCart', 'Remove an exact SKU from checkout or explicit Quote Cart.', objectSchema({
        sku: { type: 'string' },
        cartTarget: { type: 'string', enum: ['checkout', 'quote'] }
    }, ['sku']), { risk: 'mutation' }),
    tool('getCustomerAddresses', 'Read the authenticated shopper own default addresses.', objectSchema(), {
        requiresCustomer: true
    }),
    tool('updateCustomerAddress', 'Update an authenticated shopper address after secure form submission.', objectSchema({
        addressType: { type: 'string', enum: ['billing', 'shipping'] },
        address: objectSchema(addressProperties)
    }, ['addressType', 'address']), { risk: 'mutation', requiresCustomer: true }),
    tool('getRecentOrders', 'List the authenticated shopper own recent orders.', objectSchema({
        limit: { type: 'integer' }
    }), { requiresCustomer: true }),
    tool('getGuestOrders', 'List orders for the email verified in this chat session.', objectSchema({
        limit: { type: 'integer' }
    }), { requiresVerification: true }),
    tool('getGuestOrderDetails', 'Read one guest order belonging to the verified email.', objectSchema({
        orderNumber: { type: 'string' }
    }, ['orderNumber']), { requiresVerification: true }),
    tool('updateGuestOrderAddress', 'Update an eligible unshipped guest order after fresh verification.', objectSchema({
        orderNumber: { type: 'string' },
        addressType: { type: 'string', enum: ['billing', 'shipping'] },
        address: objectSchema(addressProperties)
    }, ['orderNumber', 'addressType', 'address']), { risk: 'mutation', requiresVerification: true }),
    tool('getOrderDetails', 'Read one order belonging to the authenticated shopper.', objectSchema({
        orderNumber: { type: 'string' }
    }, ['orderNumber']), { requiresCustomer: true }),
    tool('updateOrderAddress', 'Update an eligible unshipped authenticated order after secure form submission.', objectSchema({
        orderNumber: { type: 'string' },
        addressType: { type: 'string', enum: ['billing', 'shipping'] },
        address: objectSchema(addressProperties)
    }, ['orderNumber', 'addressType', 'address']), { risk: 'mutation', requiresCustomer: true }),
    tool('subscribeBackInStock', 'Subscribe the authenticated shopper to Magento product alerts.', objectSchema({
        sku: { type: 'string' }
    }, ['sku']), { risk: 'mutation', requiresCustomer: true, providers: ['openai'] }),
    tool('searchStoreKnowledge', 'Search authoritative Magento CMS policy and help content.', objectSchema({
        query: { type: 'string' },
        limit: { type: 'integer' }
    }, ['query']), { providers: ['openai'] }),
    tool('getOrderFulfillment', 'Read fulfillment, invoices, refunds, tracking and cancellation eligibility.', objectSchema({
        orderNumber: { type: 'string' }
    }, ['orderNumber']), { requiresCustomer: true, providers: ['openai'] }),
    tool('cancelOrder', 'Cancel an eligible own order only after explicit latest-message confirmation.', objectSchema({
        orderNumber: { type: 'string' },
        confirmed: { type: 'boolean' }
    }, ['orderNumber', 'confirmed']), { risk: 'destructive', requiresCustomer: true, providers: ['openai'] }),
    tool('requestReturn', 'Create a human-reviewed return request for an authenticated shopper order.', objectSchema({
        orderNumber: { type: 'string' },
        reason: { type: 'string' },
        skus: { type: 'array', items: { type: 'string' } }
    }, ['orderNumber', 'reason']), { risk: 'mutation', requiresCustomer: true, providers: ['openai'] }),
    tool('handoffToHuman', 'Create or load human support when AI cannot safely complete the request.', objectSchema({
        category: { type: 'string', enum: ['general', 'sales', 'order', 'shipping', 'billing', 'return', 'refund', 'technical'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        subject: { type: 'string' },
        summary: { type: 'string' },
        context: { type: 'object' }
    }, ['category', 'subject', 'summary']), { risk: 'human_handoff', providers: ['openai'] }),
    tool('searchWeb', 'Search current external information without sending private customer or store data.', objectSchema({
        query: { type: 'string' }
    }, ['query']), { risk: 'external_read', providers: ['openai'] }),
    tool('generateImage', 'Create a new image only after an explicit visual-generation request.', objectSchema({
        prompt: { type: 'string' }
    }, ['prompt']), { risk: 'paid_generation', providers: ['openai'] })
]);

function geminiSchema(value) {
    if (Array.isArray(value)) return value.map(geminiSchema);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
        if (key === 'additionalProperties') return [];
        if (key === 'type' && item === 'integer') return [[key, 'number']];
        return [[key, geminiSchema(item)]];
    }));
}

export function toolDefinitionsForProvider(provider) {
    return TOOL_DEFINITIONS.filter((definition) => definition.policy.providers.includes(provider));
}

export function openAiToolDefinitions() {
    return toolDefinitionsForProvider('openai').map(({ name, description, parameters }) => ({
        type: 'function',
        function: { name, description, parameters }
    }));
}

export function geminiToolDefinitions() {
    return [{
        functionDeclarations: toolDefinitionsForProvider('gemini').map(({ name, description, parameters }) => ({
            name,
            description,
            parameters: geminiSchema(parameters)
        }))
    }];
}

export function toolPolicy(name) {
    return TOOL_DEFINITIONS.find((definition) => definition.name === name)?.policy || null;
}
