import { contextBytes, estimateContextTokens, truncateUtf8Middle } from './context-budget.js';

const OMITTED_MODEL_KEYS = new Set([
    'html',
    'rendered_html',
    'address_form',
    'form_schema',
    'action_token',
    'access_token',
    'verification_token'
]);
const PROTECTED_TEXT_KEYS = new Set([
    'instruction',
    'response_language_instruction',
    'status',
    'state',
    'reason',
    'message',
    'answer',
    'order_number',
    'sku',
    'name'
]);
const ARRAY_PRIORITY_KEYS = [
    'categories',
    'sources',
    'results',
    'products',
    'orders',
    'items',
    'cases',
    'shipments',
    'invoices',
    'refunds',
    'tracks',
    'addresses'
];

/**
 * Build the provider-visible view of a tool result without mutating the raw
 * Magento response used by presentation, authorization checks or auditing.
 */
export function reduceToolResultForModel(toolName, modelResult, options = {}) {
    const maxTokens = clampInteger(options.maxTokens, 6000, 256, 24000);
    const rawBytes = safeBytes(modelResult);

    try {
        let reduced = schemaReduce(String(toolName || ''), modelResult);
        reduced = enforceBudget(reduced, maxTokens * 4);
        const reducedBytes = safeBytes(reduced);
        const useReduced = reducedBytes <= rawBytes;
        const modelContext = useReduced ? reduced : modelResult;
        const modelBytes = useReduced ? reducedBytes : rawBytes;
        const stats = Object.freeze({
            toolName: String(toolName || 'unknown').slice(0, 64),
            rawBytes,
            modelBytes,
            savedBytes: Math.max(0, rawBytes - modelBytes),
            rawEstimatedTokens: estimateContextTokens(modelResult),
            modelEstimatedTokens: estimateContextTokens(modelContext),
            reductionRatio: rawBytes > 0 ? Math.max(0, (rawBytes - modelBytes) / rawBytes) : 0,
            strategy: useReduced && modelBytes < rawBytes ? 'schema_reduced' : 'passthrough',
            budgetTokens: maxTokens
        });
        options.onStats?.(stats);
        return { modelContext, stats };
    } catch (error) {
        const stats = Object.freeze({
            toolName: String(toolName || 'unknown').slice(0, 64),
            rawBytes,
            modelBytes: rawBytes,
            savedBytes: 0,
            rawEstimatedTokens: estimateContextTokens(modelResult),
            modelEstimatedTokens: estimateContextTokens(modelResult),
            reductionRatio: 0,
            strategy: 'fallback_raw',
            budgetTokens: maxTokens,
            error: String(error?.message || 'reducer_failed').slice(0, 160)
        });
        options.onStats?.(stats);
        return { modelContext: modelResult, stats };
    }
}

function schemaReduce(toolName, value) {
    const normalized = sanitizeValue(value);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;

    switch (toolName) {
        case 'searchProducts':
            return reduceCatalog(normalized);
        case 'listCategories':
            return reduceNamedArray(normalized, 'categories', categoryIdentity);
        case 'searchWeb':
        case 'searchStoreKnowledge':
            return reduceSources(normalized);
        case 'getRecentOrders':
        case 'getGuestOrders':
            return reduceNamedArray(normalized, 'orders', orderIdentity);
        case 'getOrderDetails':
        case 'getGuestOrderDetails':
        case 'getOrderFulfillment':
            return reduceOrderDetails(normalized);
        case 'getCustomerAddresses':
            return reduceAddresses(normalized);
        default:
            return normalized;
    }
}

function reduceCatalog(value) {
    const result = reduceNamedArray(value, 'products', productIdentity);
    result.products = Array.isArray(result.products)
        ? result.products.map((product) => pick(product, [
            'id',
            'product_ref',
            'sku',
            'name',
            'price',
            'quantity_prices',
            'currency_code',
            'in_stock',
            'salable_qty',
            'url',
            'product_type',
            'direct_addable',
            'minimum_qty',
            'maximum_qty',
            'qty_increment',
            'default_add_qty',
            'requires_variant_selection',
            'variant_options',
            'variant_options_policy'
        ]))
        : result.products;
    if (result.pagination && typeof result.pagination === 'object') {
        result.pagination = pick(result.pagination, [
            'total', 'page', 'page_size', 'returned', 'has_more', 'next_page'
        ]);
    }
    return result;
}

function reduceSources(value) {
    let result = value;
    for (const key of ['sources', 'results']) {
        if (Array.isArray(result[key])) {
            result = reduceNamedArray(result, key, sourceIdentity);
            result[key] = result[key].map((source) => ({
                ...pick(source, ['title', 'url', 'excerpt', 'source_type', 'updated_at', 'source_version']),
                ...(source.excerpt ? { excerpt: truncateUtf8Middle(source.excerpt, 1600) } : {})
            }));
        }
    }
    return result;
}

function reduceOrderDetails(value) {
    const result = { ...value };
    if (result.order && typeof result.order === 'object') {
        result.order = sanitizeValue(result.order);
        if (Array.isArray(result.order.items)) {
            result.order.items = deduplicate(result.order.items, productIdentity);
        }
    }
    for (const key of ['shipments', 'invoices', 'refunds']) {
        if (Array.isArray(result[key])) result[key] = deduplicate(result[key], stableIdentity);
    }
    return result;
}

function reduceAddresses(value) {
    const result = { ...value };
    if (Array.isArray(result.addresses)) {
        result.addresses = deduplicate(result.addresses, addressIdentity);
    } else if (result.addresses && typeof result.addresses === 'object') {
        result.addresses = Object.fromEntries(
            Object.entries(result.addresses).filter(([, address]) => address && typeof address === 'object')
        );
    }
    return result;
}

function reduceNamedArray(value, key, identity) {
    if (!Array.isArray(value[key])) return value;
    const items = deduplicate(value[key], identity);
    if (key === 'orders') {
        return {
            ...value,
            [key]: items.map((order) => pick(order, [
                'order_number',
                'increment_id',
                'status',
                'state',
                'created_at',
                'grand_total',
                'currency_code',
                'items_count',
                'has_shipments',
                'can_cancel',
                'address_change_allowed',
                'address_change_reason'
            ]))
        };
    }
    return { ...value, [key]: items };
}

function sanitizeValue(value, key = '') {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        const maxBytes = PROTECTED_TEXT_KEYS.has(key) ? 8000 : (key === 'url' ? 2048 : 4000);
        return truncateUtf8Middle(value, maxBytes);
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));

    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
        if (OMITTED_MODEL_KEYS.has(childKey)) return [];
        return [[childKey, sanitizeValue(childValue, childKey)]];
    }));
}

function enforceBudget(value, maxBytes) {
    if (safeBytes(value) <= maxBytes) return value;

    let current = value;
    for (const arrayLimit of [50, 25, 10, 5, 3, 1]) {
        current = limitArrays(current, arrayLimit);
        if (safeBytes(current) <= maxBytes) return current;
    }
    for (const stringLimit of [2000, 1000, 500, 240]) {
        current = limitStrings(current, stringLimit);
        if (safeBytes(current) <= maxBytes) return current;
    }
    return current;
}

function limitArrays(value, limit, key = '') {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        const deduped = deduplicate(value, stableIdentity);
        const items = deduped.slice(0, limit).map((item) => limitArrays(item, limit, key));
        if (deduped.length > items.length) {
            items.push({ context_omitted_items: deduped.length - items.length });
        }
        return items;
    }
    const entries = Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        limitArrays(childValue, ARRAY_PRIORITY_KEYS.includes(childKey) ? limit : Math.max(limit, 10), childKey)
    ]);
    return Object.fromEntries(entries);
}

function limitStrings(value, maxBytes, key = '') {
    if (typeof value === 'string') {
        if (PROTECTED_TEXT_KEYS.has(key)) return value;
        return truncateUtf8Middle(value, maxBytes);
    }
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => limitStrings(item, maxBytes, key));
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        limitStrings(childValue, maxBytes, childKey)
    ]));
}

function deduplicate(items, identity) {
    const seen = new Set();
    return items.filter((item) => {
        const key = identity(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function productIdentity(item) {
    return String(item?.sku || item?.id || stableIdentity(item)).toLowerCase();
}

function categoryIdentity(item) {
    return String(item?.id || `${item?.parent_id || ''}:${item?.name || ''}`).toLowerCase();
}

function sourceIdentity(item) {
    return String(item?.url || `${item?.title || ''}:${item?.source_version || ''}`).toLowerCase();
}

function orderIdentity(item) {
    return String(item?.order_number || item?.increment_id || stableIdentity(item)).toLowerCase();
}

function addressIdentity(item) {
    return String(item?.id || `${item?.country_id || ''}:${item?.postcode || ''}:${item?.street || ''}`).toLowerCase();
}

function stableIdentity(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableIdentity).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableIdentity(value[key])}`).join(',')}}`;
}

function pick(value, keys) {
    return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function safeBytes(value) {
    try {
        return contextBytes(value);
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}
