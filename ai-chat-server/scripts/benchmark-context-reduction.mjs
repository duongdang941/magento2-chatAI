import { reduceToolResultForModel } from '../services/orchestration/tool-context-reducer.js';
import { contextBytes, estimateContextTokens, fitHistoryToBudget } from '../services/orchestration/context-budget.js';

function product(index) {
    return {
        id: index,
        sku: `SKU-${index}`,
        name: `Configurable product ${index}`,
        price: '€49.95',
        in_stock: true,
        url: `https://store.example.test/product-${index}.html`,
        direct_addable: false,
        minimum_qty: 1,
        maximum_qty: 1000,
        qty_increment: 1,
        default_add_qty: 1,
        variant_options: {
            color: ['Blue', 'Red', 'Black'],
            size: ['S', 'M', 'L', 'XL']
        },
        presentation_note: 'This field is not required for model reasoning.'
    };
}

const representativeAddressForm = {
    fields: Array.from({ length: 10 }, (_, index) => ({
        code: `field_${index}`,
        label: `Address field ${index}`,
        input_type: 'text',
        required: index < 6,
        line_count: 1
    })),
    countries: [{ value: 'DE', label: 'Deutschland', is_region_required: false, is_zip_required: true }],
    regions: {}
};

const stressAddressForm = {
    fields: Array.from({ length: 18 }, (_, index) => ({
        code: `field_${index}`,
        label: `Address field ${index}`,
        validation: { required: index < 8, max_text_length: 255 }
    })),
    countries: Array.from({ length: 249 }, (_, index) => ({
        id: `C${index}`,
        name: `Country ${index}`,
        regions: Array.from({ length: 12 }, (_, region) => ({ id: region, name: `Region ${region}` }))
    }))
};

const representativeCases = [
    ['searchProducts', {
        products_found: 5,
        total_products: 80,
        pagination: { total: 80, page: 1, page_size: 5, returned: 5, has_more: true, next_page: 2 },
        products: Array.from({ length: 5 }, (_, index) => product(index + 1)),
        instruction: 'Only mention returned Magento products and retain coverage metadata.'
    }],
    ['getOrderDetails', {
        status: 'success',
        order: {
            order_number: '100000321',
            status: 'Processing',
            state: 'processing',
            address_change_allowed: true,
            items: Array.from({ length: 12 }, (_, index) => ({ sku: `SKU-${index}`, name: `Item ${index}`, qty_ordered: 1 })),
            billing_address: { firstname: 'Test', lastname: 'Customer', country_id: 'DE' },
            shipping_address: { firstname: 'Test', lastname: 'Customer', country_id: 'DE' },
            address_form: representativeAddressForm
        },
        instruction: 'Use only owned order data.'
    }],
    ['getCustomerAddresses', {
        status: 'success',
        addresses: {
            billing: { firstname: 'Test', lastname: 'Customer', street: ['Street 1'], city: 'Berlin', country_id: 'DE' },
            shipping: { firstname: 'Test', lastname: 'Customer', street: ['Street 2'], city: 'Berlin', country_id: 'DE' }
        },
        address_form: representativeAddressForm,
        instruction: 'Summarize the returned default addresses.'
    }],
    ['searchWeb', {
        status: 'success',
        answer: 'A concise provider synthesis with dated facts and source references. '.repeat(50),
        sources: Array.from({ length: 8 }, (_, index) => ({
            title: `Source ${index}`,
            url: `https://example.test/source-${index}`
        })),
        instruction: 'Synthesize only from returned excerpts and cite sources.'
    }]
];

const stressCases = [
    ['searchProducts', {
        products_found: 10,
        total_products: 80,
        pagination: { total: 80, page: 1, page_size: 10, returned: 10, has_more: true, next_page: 2 },
        products: [...Array.from({ length: 10 }, (_, index) => ({
            ...product(index + 1),
            description: 'Long upstream description that is irrelevant to this reasoning step. '.repeat(120)
        })), product(1), product(2)],
        instruction: 'Only mention returned Magento products and retain coverage metadata.'
    }],
    ['getOrderDetails', {
        ...representativeCases[1][1],
        order: { ...representativeCases[1][1].order, address_form: stressAddressForm }
    }],
    ['getCustomerAddresses', {
        ...representativeCases[2][1],
        address_form: stressAddressForm
    }],
    representativeCases[3],
    ['searchStoreKnowledge', {
        status: 'success',
        sources: Array.from({ length: 8 }, (_, index) => ({
            title: `Policy ${index}`,
            url: `https://store.example.test/policy-${Math.floor(index / 2)}`,
            excerpt: `Authoritative policy excerpt ${index}. `.repeat(180),
            source_type: 'cms_page',
            updated_at: '2026-08-13'
        })),
        instruction: 'Answer only from authoritative Magento CMS excerpts.'
    }]
];

function benchmark(cases) {
    const rows = cases.map(([toolName, before]) => {
        const { stats } = reduceToolResultForModel(toolName, before, { maxTokens: 6000 });
        return {
            tool: toolName,
            before_bytes: stats.rawBytes,
            after_bytes: stats.modelBytes,
            before_estimated_tokens: stats.rawEstimatedTokens,
            after_estimated_tokens: stats.modelEstimatedTokens,
            reduction_percent: Number((stats.reductionRatio * 100).toFixed(1))
        };
    });
    const totals = rows.reduce((result, row) => ({
        before_bytes: result.before_bytes + row.before_bytes,
        after_bytes: result.after_bytes + row.after_bytes,
        before_estimated_tokens: result.before_estimated_tokens + row.before_estimated_tokens,
        after_estimated_tokens: result.after_estimated_tokens + row.after_estimated_tokens
    }), { before_bytes: 0, after_bytes: 0, before_estimated_tokens: 0, after_estimated_tokens: 0 });
    totals.reduction_percent = Number(((1 - totals.after_bytes / totals.before_bytes) * 100).toFixed(1));
    return { rows, totals };
}

function historyBenchmark({ turns, wordsPerMessage, budgetTokens }) {
    const history = Array.from({ length: turns }, (_, index) => ({
        role: index % 2 ? 'model' : 'user',
        parts: [{ text: `Turn ${index}: ${'commerce detail '.repeat(wordsPerMessage)}` }]
    }));
    const fitted = fitHistoryToBudget(history, { maxMessages: 40, maxTokens: budgetTokens });
    const beforeBytes = contextBytes(history);
    const afterBytes = contextBytes(fitted);
    return {
        input_messages: history.length,
        model_messages: fitted.length,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
        before_estimated_tokens: estimateContextTokens(history),
        after_estimated_tokens: estimateContextTokens(fitted),
        reduction_percent: Number(((1 - afterBytes / beforeBytes) * 100).toFixed(1)),
        budget_tokens: budgetTokens
    };
}

console.log(JSON.stringify({
    method: 'UTF-8 bytes / 4 token estimate',
    note: 'Provider billing tokenization varies; byte counts are authoritative for this benchmark.',
    representative: benchmark(representativeCases),
    stress: benchmark(stressCases),
    history: {
        short_conversation: historyBenchmark({ turns: 10, wordsPerMessage: 20, budgetTokens: 12000 }),
        long_conversation: historyBenchmark({ turns: 40, wordsPerMessage: 180, budgetTokens: 12000 })
    }
}, null, 2));
