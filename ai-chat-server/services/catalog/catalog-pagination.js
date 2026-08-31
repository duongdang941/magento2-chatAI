import crypto from 'node:crypto';

export const DEFAULT_CATALOG_PAGE_SIZE = 5;
export const MAX_CATALOG_PAGE_SIZE = 10;
export const MAX_CATALOG_CARDS_IN_CHAT = 20;

const PAGINATION_TOKEN_TTL_SECONDS = 15 * 60;
const paginationSecret = process.env.AI_CATALOG_PAGINATION_SECRET
    || process.env.AI_NODE_SYNC_SECRET
    // A development gateway without a configured secret can still offer page
    // buttons. Tokens deliberately expire after a restart in that case.
    || crypto.randomBytes(32).toString('hex');

export function buildCatalogProductsPayload(content = {}, args = {}) {
    const rawItems = Array.isArray(content.data) ? content.data : [];
    const pagination = normalizeCatalogPagination(content.meta?.pagination, rawItems.length, args);
    // Defence in depth: a Magento adapter must never make the chat render more
    // cards than the signed page contract allows.
    const items = rawItems.slice(0, pagination.page_size);
    const productIds = items
        .map((item) => Number(item?.id || 0))
        .filter((id) => id > 0);
    pagination.returned = items.length;
    const scope = normalizeCatalogScope(
        content.meta?.scope,
        args.categoryId,
        args.directAddOnly === true,
        args.browseAll === true
    );
    const catalogContext = createCatalogResultSetContext(args, scope);
    const cardsShownAfterPage = pagination.page * pagination.page_size;
    const canLoadMore = pagination.has_more && cardsShownAfterPage < MAX_CATALOG_CARDS_IN_CHAT;
    const coverage = {
        shown: items.length,
        total: pagination.total,
        remaining: pagination.total_is_verified ? Math.max(0, pagination.total - items.length) : null,
        complete: !pagination.has_more
    };
    const continuation = canLoadMore
        ? createCatalogPageToken({
            query: String(args.query || ''),
            categoryId: scope.category_id || 0,
            page: pagination.next_page,
            pageSize: pagination.page_size,
            minPrice: positivePrice(args.minPrice),
            maxPrice: positivePrice(args.maxPrice),
            priceCurrency: normalizePriceCurrency(args.priceCurrency),
            pricePreference: normalizePricePreference(args.pricePreference),
            directAddOnly: scope.direct_add_only,
            browseAll: scope.browse_all,
            requiredVariantAttributeCode: normalizeVariantAttributeCode(args.requiredVariantAttributeCode),
            requiredVariantOptionValues: normalizeVariantOptionValues(args.requiredVariantOptionValues),
            excludedVariantOptionValues: normalizeVariantOptionValues(args.excludedVariantOptionValues)
        })
        : null;

    return {
        items,
        productIds,
        coverage,
        pagination: {
            ...pagination,
            can_load_more: Boolean(continuation),
            chat_card_limit: MAX_CATALOG_CARDS_IN_CHAT,
            truncated_for_chat: pagination.has_more && !continuation
        },
        scope,
        payload: {
            contract_version: 2,
            kind: 'product_list',
            query: String(args.query || ''),
            product_ids: productIds,
            items,
            total: pagination.total,
            coverage,
            pagination: {
                ...pagination,
                can_load_more: Boolean(continuation),
                chat_card_limit: MAX_CATALOG_CARDS_IN_CHAT,
                truncated_for_chat: pagination.has_more && !continuation
            },
            scope,
            // This is a private correlation contract which the browser keeps
            // only in CATALOG_CONTEXT for a later semantic follow-up. It
            // contains the retrieval constraints, never product facts; the
            // follow-up still performs a fresh Magento search.
            catalog_context: catalogContext,
            direct_add_only: scope.direct_add_only,
            ...(scope.browse_all ? { browse_all: true } : {}),
            ...(positivePrice(args.minPrice) ? { min_price: positivePrice(args.minPrice) } : {}),
            ...(positivePrice(args.maxPrice) ? { max_price: positivePrice(args.maxPrice) } : {}),
            ...(normalizePriceCurrency(args.priceCurrency) ? { price_currency: normalizePriceCurrency(args.priceCurrency) } : {}),
            ...(normalizePricePreference(args.pricePreference) === 'lowest' ? { price_preference: 'lowest' } : {}),
            ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
                ? { required_variant_attribute_code: normalizeVariantAttributeCode(args.requiredVariantAttributeCode) }
                : {}),
            ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
                && normalizeVariantOptionValues(args.requiredVariantOptionValues).length > 0
                ? { required_variant_option_values: normalizeVariantOptionValues(args.requiredVariantOptionValues) }
                : {}),
            ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
                && normalizeVariantOptionValues(args.excludedVariantOptionValues).length > 0
                ? { excluded_variant_option_values: normalizeVariantOptionValues(args.excludedVariantOptionValues) }
                : {}),
            continuation
        }
    };
}

/**
 * Correlate a multi-card grid with its bounded Magento retrieval contract.
 * A product reference is only safe for a single card; this reference serves
 * the different case where a shopper asks a factual follow-up about the whole
 * result set (for example its current price range). The hash is an opaque
 * equality key, not an authorization token and never contains shopper text.
 */
function createCatalogResultSetContext(args = {}, scope = {}) {
    const request = {
        query: String(args.query || '').trim().slice(0, 160),
        category_id: Math.max(0, Number(scope.category_id) || 0),
        ...(positivePrice(args.minPrice) ? { min_price: positivePrice(args.minPrice) } : {}),
        ...(positivePrice(args.maxPrice) ? { max_price: positivePrice(args.maxPrice) } : {}),
        ...(normalizePriceCurrency(args.priceCurrency) ? { price_currency: normalizePriceCurrency(args.priceCurrency) } : {}),
        ...(normalizePricePreference(args.pricePreference) === 'lowest' ? { price_preference: 'lowest' } : {}),
        ...(scope.direct_add_only === true ? { direct_add_only: true } : {}),
        ...(scope.browse_all === true ? { browse_all: true } : {}),
        ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
            ? { required_variant_attribute_code: normalizeVariantAttributeCode(args.requiredVariantAttributeCode) }
            : {}),
        ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
            && normalizeVariantOptionValues(args.requiredVariantOptionValues).length > 0
            ? { required_variant_option_values: normalizeVariantOptionValues(args.requiredVariantOptionValues) }
            : {}),
        ...(normalizeVariantAttributeCode(args.requiredVariantAttributeCode)
            && normalizeVariantOptionValues(args.excludedVariantOptionValues).length > 0
            ? { excluded_variant_option_values: normalizeVariantOptionValues(args.excludedVariantOptionValues) }
            : {})
    };
    const searchRef = crypto.createHash('sha256')
        .update(JSON.stringify(request), 'utf8')
        .digest('hex')
        .slice(0, 24);

    return {
        version: 1,
        search_ref: `search:${searchRef}`,
        request
    };
}

/**
 * History deliberately never stores a signed continuation token. Recreate a
 * fresh, bounded token from the persisted pagination contract only after the
 * authenticated gateway has loaded that conversation for its owner.
 */
export function rehydrateCatalogContinuation(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;

    const paginationSource = payload.pagination && typeof payload.pagination === 'object'
        ? payload.pagination
        : null;
    if (!paginationSource) return payload;

    const items = Array.isArray(payload.items) ? payload.items : [];
    const pageSize = clampInteger(
        paginationSource.page_size,
        1,
        MAX_CATALOG_PAGE_SIZE,
        DEFAULT_CATALOG_PAGE_SIZE
    );
    const page = clampInteger(paginationSource.page, 1, 10000, 1);
    const totalIsVerified = paginationSource.total_is_verified !== false;
    const total = totalIsVerified
        ? Math.max(
            items.length,
            clampInteger(paginationSource.total ?? payload.total, 0, Number.MAX_SAFE_INTEGER, items.length)
        )
        : null;
    const hasMore = paginationSource.has_more === true
        || (totalIsVerified && (page * pageSize) < total);
    const cardsShownAfterPage = page * pageSize;
    const canLoadMore = hasMore && cardsShownAfterPage < MAX_CATALOG_CARDS_IN_CHAT;
    const scope = normalizeCatalogScope(
        payload.scope,
        Number(payload.scope?.category_id) || 0,
        payload.direct_add_only === true || payload.scope?.direct_add_only === true,
        payload.browse_all === true || payload.scope?.browse_all === true
    );
    const continuation = canLoadMore
        ? createCatalogPageToken({
            query: String(payload.query || ''),
            categoryId: scope.category_id || 0,
            page: page + 1,
            pageSize,
            minPrice: positivePrice(payload.min_price ?? payload.minPrice),
            maxPrice: positivePrice(payload.max_price ?? payload.maxPrice),
            priceCurrency: normalizePriceCurrency(payload.price_currency ?? payload.priceCurrency),
            pricePreference: normalizePricePreference(payload.price_preference ?? payload.pricePreference),
            directAddOnly: scope.direct_add_only,
            browseAll: scope.browse_all,
            requiredVariantAttributeCode: normalizeVariantAttributeCode(payload.required_variant_attribute_code),
            requiredVariantOptionValues: normalizeVariantOptionValues(payload.required_variant_option_values),
            excludedVariantOptionValues: normalizeVariantOptionValues(payload.excluded_variant_option_values)
        })
        : null;

    return {
        ...payload,
        total,
        coverage: {
            ...(payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {}),
            shown: items.length,
            total,
            remaining: totalIsVerified ? Math.max(0, total - items.length) : null,
            complete: !hasMore
        },
        pagination: {
            ...paginationSource,
            page,
            page_size: pageSize,
            total,
            total_is_verified: totalIsVerified,
            returned: items.length,
            has_more: hasMore,
            next_page: hasMore ? page + 1 : null,
            can_load_more: Boolean(continuation),
            chat_card_limit: MAX_CATALOG_CARDS_IN_CHAT,
            truncated_for_chat: hasMore && !continuation
        },
        scope,
        direct_add_only: scope.direct_add_only,
        ...(scope.browse_all ? { browse_all: true } : {}),
        ...(normalizePricePreference(payload.price_preference ?? payload.pricePreference) === 'lowest'
            ? { price_preference: 'lowest' }
            : {}),
        ...(normalizeVariantAttributeCode(payload.required_variant_attribute_code)
            ? { required_variant_attribute_code: normalizeVariantAttributeCode(payload.required_variant_attribute_code) }
            : {}),
        ...(normalizeVariantAttributeCode(payload.required_variant_attribute_code)
            && normalizeVariantOptionValues(payload.required_variant_option_values).length > 0
            ? { required_variant_option_values: normalizeVariantOptionValues(payload.required_variant_option_values) }
            : {}),
        ...(normalizeVariantAttributeCode(payload.required_variant_attribute_code)
            && normalizeVariantOptionValues(payload.excluded_variant_option_values).length > 0
            ? { excluded_variant_option_values: normalizeVariantOptionValues(payload.excluded_variant_option_values) }
            : {}),
        continuation
    };
}

export function createCatalogPageToken(context = {}) {
    const page = clampInteger(context.page, 2, 10000, 2);
    const pageSize = clampInteger(context.pageSize, 1, MAX_CATALOG_PAGE_SIZE, DEFAULT_CATALOG_PAGE_SIZE);
    const categoryId = clampInteger(context.categoryId, 0, Number.MAX_SAFE_INTEGER, 0);
    const directAddOnly = context.directAddOnly === true;
    const browseAll = context.browseAll === true;
    const minPrice = positivePrice(context.minPrice);
    const maxPrice = positivePrice(context.maxPrice);
    const priceCurrency = normalizePriceCurrency(context.priceCurrency);
    const pricePreference = normalizePricePreference(context.pricePreference);
    const requiredVariantAttributeCode = normalizeVariantAttributeCode(context.requiredVariantAttributeCode);
    const requiredVariantOptionValues = normalizeVariantOptionValues(context.requiredVariantOptionValues);
    const excludedVariantOptionValues = normalizeVariantOptionValues(context.excludedVariantOptionValues);
    const payload = {
        v: 1,
        exp: Math.floor(Date.now() / 1000) + PAGINATION_TOKEN_TTL_SECONDS,
        query: String(context.query || '').trim().slice(0, 160),
        category_id: categoryId,
        page,
        page_size: pageSize,
        ...(minPrice ? { min_price: minPrice } : {}),
        ...(maxPrice ? { max_price: maxPrice } : {}),
        ...(priceCurrency ? { price_currency: priceCurrency } : {}),
        ...(pricePreference === 'lowest' ? { price_preference: 'lowest' } : {}),
        ...(requiredVariantAttributeCode ? { required_variant_attribute_code: requiredVariantAttributeCode } : {}),
        ...(requiredVariantAttributeCode && requiredVariantOptionValues.length > 0
            ? { required_variant_option_values: requiredVariantOptionValues }
            : {}),
        ...(requiredVariantAttributeCode && excludedVariantOptionValues.length > 0
            ? { excluded_variant_option_values: excludedVariantOptionValues }
            : {}),
        ...(directAddOnly ? { direct_add_only: true } : {}),
        ...(browseAll ? { browse_all: true } : {})
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', paginationSecret).update(encoded, 'utf8').digest('base64url');

    return `${encoded}.${signature}`;
}

export function verifyCatalogPageToken(token) {
    const [encoded, signature, extra] = String(token || '').split('.');
    if (!encoded || !signature || extra) return null;

    const expected = crypto.createHmac('sha256', paginationSecret).update(encoded, 'utf8').digest('base64url');
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    if (actualBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
        return null;
    }

    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!parsed || parsed.v !== 1 || Number(parsed.exp) < Math.floor(Date.now() / 1000)) {
            return null;
        }

        const page = clampInteger(parsed.page, 2, 10000, 0);
        const pageSize = clampInteger(parsed.page_size, 1, MAX_CATALOG_PAGE_SIZE, 0);
        if (!page || !pageSize) return null;

        return {
            query: String(parsed.query || '').trim().slice(0, 160),
            categoryId: clampInteger(parsed.category_id, 0, Number.MAX_SAFE_INTEGER, 0),
            page,
            pageSize,
            ...(positivePrice(parsed.min_price) ? { minPrice: positivePrice(parsed.min_price) } : {}),
            ...(positivePrice(parsed.max_price) ? { maxPrice: positivePrice(parsed.max_price) } : {}),
            ...(normalizePriceCurrency(parsed.price_currency) ? { priceCurrency: normalizePriceCurrency(parsed.price_currency) } : {}),
            ...(normalizePricePreference(parsed.price_preference) === 'lowest' ? { pricePreference: 'lowest' } : {}),
            ...(normalizeVariantAttributeCode(parsed.required_variant_attribute_code)
                ? { requiredVariantAttributeCode: normalizeVariantAttributeCode(parsed.required_variant_attribute_code) }
                : {}),
            ...(normalizeVariantAttributeCode(parsed.required_variant_attribute_code)
                && normalizeVariantOptionValues(parsed.required_variant_option_values).length > 0
                ? { requiredVariantOptionValues: normalizeVariantOptionValues(parsed.required_variant_option_values) }
                : {}),
            ...(normalizeVariantAttributeCode(parsed.required_variant_attribute_code)
                && normalizeVariantOptionValues(parsed.excluded_variant_option_values).length > 0
                ? { excludedVariantOptionValues: normalizeVariantOptionValues(parsed.excluded_variant_option_values) }
                : {}),
            ...(parsed.direct_add_only === true ? { directAddOnly: true } : {}),
            ...(parsed.browse_all === true ? { browseAll: true } : {})
        };
    } catch {
        return null;
    }
}

function normalizeCatalogPagination(rawPagination, returned, args) {
    const source = rawPagination && typeof rawPagination === 'object' ? rawPagination : {};
    const pageSize = clampInteger(
        source.page_size ?? args.limit ?? args.pageSize,
        1,
        MAX_CATALOG_PAGE_SIZE,
        DEFAULT_CATALOG_PAGE_SIZE
    );
    const page = clampInteger(source.page ?? args.page, 1, 10000, 1);
    const safeReturned = Math.max(0, Number(returned) || 0);
    const totalIsVerified = source.total_is_verified !== false;
    const total = totalIsVerified
        ? Math.max(
            safeReturned,
            clampInteger(source.total, 0, Number.MAX_SAFE_INTEGER, safeReturned)
        )
        : null;
    const hasMore = source.has_more === true
        || (totalIsVerified && (page * pageSize) < total);

    return {
        total,
        total_is_verified: totalIsVerified,
        page,
        page_size: pageSize,
        returned: safeReturned,
        has_more: hasMore,
        next_page: hasMore ? clampInteger(source.next_page, page + 1, 10000, page + 1) : null
    };
}

function normalizeCatalogScope(rawScope, categoryId, directAddOnly = false, browseAll = false) {
    const source = rawScope && typeof rawScope === 'object' ? rawScope : {};
    const categoryUrl = String(source.category_url || '').trim();

    return {
        category_id: clampInteger(source.category_id ?? categoryId, 0, Number.MAX_SAFE_INTEGER, 0) || null,
        category_name: String(source.category_name || '').trim(),
        category_url: /^https?:\/\//i.test(categoryUrl) || categoryUrl.startsWith('/') ? categoryUrl : '',
        includes_descendants: source.includes_descendants === true,
        unavailable_query_match: source.unavailable_query_match === true,
        similarity_fallback: source.similarity_fallback === true,
        ...(source.direct_add_only === true || directAddOnly ? { direct_add_only: true } : {}),
        ...(source.browse_all === true || browseAll ? { browse_all: true } : {})
    };
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function positivePrice(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizePriceCurrency(value) {
    const currency = String(value || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function normalizePricePreference(value) {
    return String(value || '').trim().toLowerCase() === 'lowest' ? 'lowest' : '';
}

function normalizeVariantAttributeCode(value) {
    const code = String(value || '').trim().toLowerCase();
    return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : '';
}

function normalizeVariantOptionValues(value) {
    const raw = Array.isArray(value)
        ? value
        : (() => {
            if (typeof value !== 'string') return [];
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        })();

    return [...new Set(raw
        .map((item) => String(item || '').trim())
        .filter((item) => item && item.length <= 120)
        .slice(0, 12))];
}
