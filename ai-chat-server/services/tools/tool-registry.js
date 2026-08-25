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

// Customer-facing action copy is supplied by the model in the shopper's own
// language. The tool contract remains semantic and works for every locale;
// the gateway never owns a finite translation table for these labels.
const activityPresentationSchema = Object.freeze(objectSchema({
    language: {
        type: 'string',
        description: 'BCP-47 tag for all labels. It must match the shopper request language.'
    },
    runningLabel: {
        type: 'string',
        description: 'Short shopper-safe phrase shown while this action is still running. Use in-progress phrasing that stays true for the entire duration (an equivalent of "Looking up products…"). Never completion phrasing such as "finished", "completed", "done", or an equivalent. Do not include tool names, arguments, product/category names, identifiers, URLs, personal data, markup, or internal details.'
    },
    completedLabel: {
        type: 'string',
        description: 'Short shopper-safe phrase shown only after this same action completes. Use completion phrasing (an equivalent of "Finished looking up products"). It must describe the same action as runningLabel and must not include tool names, arguments, product/category names, identifiers, URLs, personal data, markup, or internal details.'
    },
    failedLabel: {
        type: 'string',
        description: 'Short shopper-safe phrase shown only if this same action cannot complete. Use failure phrasing (an equivalent of "Could not look up products"). It must describe the same action as runningLabel and must not include tool names, arguments, product/category names, identifiers, URLs, personal data, markup, or internal details.'
    },
    runningSummary: {
        type: 'string',
        description: 'Short live-turn summary template in language, containing the literal token {duration} exactly once, for example an equivalent of "Working for {duration}". Use in-progress phrasing; never completion phrasing such as "finished" or "done". Do not include tool names, data, markup, or URLs.'
    },
    completedSummary: {
        type: 'string',
        description: 'Short completed-turn summary template in language, containing the literal token {duration} exactly once, for example an equivalent of "Worked for {duration}". Use completion phrasing. Do not include tool names, data, markup, or URLs.'
    }
}, ['language', 'runningLabel', 'completedLabel', 'failedLabel', 'runningSummary', 'completedSummary']));

// Product search needs one extra model-localized phrase to identify the
// verified search scope. The gateway materializes `{category}` later, after
// Magento has supplied the actual category name; it never trusts a name from
// the model call.
const productSearchActivityPresentationSchema = Object.freeze(objectSchema({
    ...activityPresentationSchema.properties,
    searchScope: {
        type: 'string',
        description: 'Required short shopper-language phrase stating where this product search runs. When categoryId is absent, explicitly say the whole store (for example an equivalent of "in the store"). When categoryId is present, use the literal token {category} exactly once (for example an equivalent of "in category {category}"). Do not invent or write a category name yourself.'
    }
}, [...activityPresentationSchema.required, 'searchScope']));

function withActivityPresentation(parameters = {}, presentationSchema = activityPresentationSchema) {
    return Object.freeze({
        ...parameters,
        properties: {
            ...(parameters.properties || {}),
            activityPresentation: presentationSchema
        },
        required: [...new Set([...(parameters.required || []), 'activityPresentation'])]
    });
}

const tool = (name, description, parameters, policy = {}) => {
    const { presentationSchema = activityPresentationSchema, ...toolPolicy } = policy;
    return Object.freeze({
        name,
        description,
        parameters: withActivityPresentation(parameters, presentationSchema),
        policy: Object.freeze({
            risk: toolPolicy.risk || 'read',
            requiresCustomer: toolPolicy.requiresCustomer === true,
            requiresVerification: toolPolicy.requiresVerification === true,
            providers: Object.freeze(toolPolicy.providers || ['openai', 'gemini'])
        })
    });
};

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
        priceCurrency: { type: 'string', description: 'ISO 4217 currency explicitly written by the shopper, for example USD.' },
        directAddOnly: { type: 'boolean' },
        exactIdentity: { type: 'boolean' },
        excludedTerms: { type: 'array', items: { type: 'string' } },
        responseLanguage: { type: 'string' },
        responseLanguageEvidence: { type: 'array', items: { type: 'string' } }
    }, ['query', 'exactIdentity', 'responseLanguage', 'responseLanguageEvidence']), {
        presentationSchema: productSearchActivityPresentationSchema
    }),
    tool('compareProducts', 'Compare two returned Magento products by exact SKU.', objectSchema({
        sku1: { type: 'string' },
        sku2: { type: 'string' }
    }, ['sku1', 'sku2'])),
    tool('getProductAvailability', 'Check live Magento salable quantity for an exact returned SKU.', objectSchema({
        sku: { type: 'string' },
        selectedOptions: { type: 'object', additionalProperties: { type: 'string' } }
    }, ['sku'])),
    tool('listCategories', 'Inspect the real Magento category taxonomy.', objectSchema({
        lookupPurpose: {
            type: 'string',
            enum: ['product_discovery', 'taxonomy_question'],
            description: 'product_discovery when taxonomy is needed to find/show products; taxonomy_question only when the shopper explicitly asks about the category structure itself.'
        },
        responseLanguage: { type: 'string' },
        responseLanguageEvidence: { type: 'array', items: { type: 'string' } }
    }, ['lookupPurpose', 'responseLanguage', 'responseLanguageEvidence'])),
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
    tool('getGuestOrders', 'MANDATORY FIRST ACTION for an unauthenticated shopper asking about their own orders. List orders for the email verified in this chat session; when not verified, the gateway opens the secure email card.', objectSchema({
        limit: { type: 'integer' }
    }), { requiresVerification: true }),
    tool('getGuestOrderDetails', 'MANDATORY for an unauthenticated shopper asking about one of their own orders. Read that guest order belonging to the verified email; when not verified, the gateway opens the secure email card.', objectSchema({
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
    }, ['sku']), { risk: 'mutation', requiresCustomer: true }),
    tool('searchStoreKnowledge', 'Search authoritative Magento CMS policy and help content.', objectSchema({
        query: { type: 'string' },
        limit: { type: 'integer' }
    }, ['query'])),
    tool('getOrderFulfillment', 'Read fulfillment, invoices, refunds, tracking and cancellation eligibility.', objectSchema({
        orderNumber: { type: 'string' }
    }, ['orderNumber']), { requiresCustomer: true }),
    tool('cancelOrder', 'Cancel an eligible own order only after explicit latest-message confirmation.', objectSchema({
        orderNumber: { type: 'string' },
        confirmed: { type: 'boolean' }
    }, ['orderNumber', 'confirmed']), { risk: 'destructive', requiresCustomer: true }),
    tool('requestReturn', 'Create a human-reviewed return request for an authenticated shopper order.', objectSchema({
        orderNumber: { type: 'string' },
        reason: { type: 'string' },
        skus: { type: 'array', items: { type: 'string' } }
    }, ['orderNumber', 'reason']), { risk: 'mutation', requiresCustomer: true }),
    tool('handoffToHuman', 'Open the verified human-support portal. This loads the shopper\'s existing private tickets and lets the shopper choose one or start a new private support conversation; it does not start an instant live-agent call.', objectSchema({
        category: { type: 'string', enum: ['general', 'sales', 'order', 'shipping', 'billing', 'return', 'refund', 'technical'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        subject: { type: 'string' },
        summary: { type: 'string' },
        context: { type: 'object' }
    }, ['category', 'subject', 'summary']), { risk: 'human_handoff' }),
    tool('searchWeb', 'Search current external information without sending private customer or store data.', objectSchema({
        query: { type: 'string' }
    }, ['query']), { risk: 'external_read' }),
    tool('generateImage', 'Create a new visual picture, image, or artwork only when the user explicitly asks to draw or generate an image. Never use for text writing, essays, stories, poems, or text descriptions. If the selected provider has no native Image API, call this tool again with svg_content: a complete self-contained SVG document generated by the chat model. The SVG must not contain scripts, event handlers, foreignObject, external URLs, data URLs, or embedded resources.', objectSchema({
        prompt: { type: 'string' },
        svg_content: { type: 'string', description: 'Optional complete self-contained SVG document used when the chat model must create the artwork as a safe SVG file instead of calling a native image API.' }
    }, ['prompt']), { risk: 'paid_generation' })
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
    const normalizedProvider = String(provider || '').toLowerCase();
    const policyProvider = ['cockpit', 'openrouter', '9router'].includes(normalizedProvider)
        ? 'openai'
        : normalizedProvider;
    return TOOL_DEFINITIONS.filter((definition) => definition.policy.providers.includes(policyProvider));
}

export function anthropicToolDefinitions() {
    return TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({
        name,
        description,
        input_schema: parameters
    }));
}

export function openAiToolDefinitions(provider = 'openai') {
    return toolDefinitionsForProvider(provider).map(({ name, description, parameters }) => ({
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
