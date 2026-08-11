import axios from 'axios';
import { createInternalMagentoRequestConfig, createMagentoRequestConfig } from './magento-auth.js';
import { normalizeSearchArguments } from './catalog-tool-arguments.js';
import { MAX_CATALOG_PAGE_SIZE } from './catalog-pagination.js';
import {
    catalogRestUrl,
    catalogScopeCacheIdentity,
    catalogScopeRequestParams
} from './catalog-scope.js';

const MAGENTO_URL = process.env.MAGENTO_API_URL || 'http://afd.test';

/**
 * Retrieves a signed continuation page without invoking the LLM again. The
 * input comes exclusively from a verified continuation token in server.js.
 */
export async function loadCatalogPage(context, aiConfig, runtime = null) {
    const params = normalizeSearchArguments({
        query: context.query,
        categoryId: context.categoryId,
        page: context.page,
        limit: context.pageSize,
        directAddOnly: context.directAddOnly === true
    }, MAX_CATALOG_PAGE_SIZE, context.pageSize);
    Object.assign(params, catalogScopeRequestParams(context.catalogScope, context.customerId));
    const url = catalogRestUrl(MAGENTO_URL, 'afd-ai/products/search', context.catalogScope);
    const loader = async () => {
        const requestUrl = appendQuery(url, params);
        const oauth = createMagentoRequestConfig('GET', requestUrl, {
            timeout: 20000,
            signParams: {},
            magentoOauth: aiConfig?.magento_oauth || {}
        });
        const internal = createInternalMagentoRequestConfig('GET', requestUrl, '', { timeout: 20000 });
        const response = await axios.get(requestUrl, {
            ...oauth,
            ...internal,
            headers: { ...oauth.headers, ...internal.headers }
        });

        return normalizeMagentoToolResponse(response.data);
    };

    if (Number(context.customerId) > 0 || !runtime || typeof runtime.getOrSetJsonCache !== 'function') {
        return { content: await loader(), params };
    }

    const cached = await runtime.getOrSetJsonCache(
        'catalog-search',
        JSON.stringify({
            params,
            catalog: catalogScopeCacheIdentity(context.catalogScope),
            catalog_version: await runtime.getCacheVersion?.('catalog') || 0
        }),
        { ttlMs: 60000, lockMs: 15000, waitMs: 20000 },
        loader
    );

    return { content: cached.value, params };
}

function appendQuery(url, params = {}) {
    const requestUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        requestUrl.searchParams.set(key, String(value));
    }
    return requestUrl.toString();
}

export function normalizeMagentoToolResponse(payload) {
    if (!payload || typeof payload !== 'object') return payload;

    const normalized = { ...payload };
    if (Array.isArray(normalized.data)) {
        normalized.data = normalized.data
            .map((item) => normalizeMagentoDataItem(item))
            .filter((item) => item !== null && item !== '');
    }
    normalized.meta = normalizeMagentoMetadata(normalized.meta);

    return normalized;
}

function normalizeMagentoDataItem(item) {
    if (typeof item !== 'string') return item;

    const trimmed = item.trim();
    if (!trimmed) return null;

    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return item;
        }
    }

    return item;
}

function normalizeMagentoMetadata(value) {
    if (!value) return {};

    if (!Array.isArray(value) && typeof value === 'object') {
        return value;
    }

    const parts = (Array.isArray(value) ? value : [value])
        .map((part) => normalizeMagentoDataItem(part))
        .filter((part) => part && typeof part === 'object' && !Array.isArray(part));

    // Magento Web API serializes associative arrays from a service contract as
    // positional JSON arrays. CatalogSearchTool deliberately puts pagination
    // first and scope second; reconstruct named fields at the Node boundary.
    const pagination = parts.find((part) => Object.prototype.hasOwnProperty.call(part, 'page_size')) || {};
    const scope = parts.find((part) => Object.prototype.hasOwnProperty.call(part, 'category_id')) || {};

    return { pagination, scope };
}
