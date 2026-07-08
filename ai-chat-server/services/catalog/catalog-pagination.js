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
    const scope = normalizeCatalogScope(content.meta?.scope, args.categoryId, args.directAddOnly === true);
    const cardsShownAfterPage = pagination.page * pagination.page_size;
    const canLoadMore = pagination.has_more && cardsShownAfterPage < MAX_CATALOG_CARDS_IN_CHAT;
    const coverage = {
        shown: items.length,
        total: pagination.total,
        remaining: Math.max(0, pagination.total - items.length),
        complete: !pagination.has_more && items.length >= pagination.total
    };
    const continuation = canLoadMore
        ? createCatalogPageToken({
            query: String(args.query || ''),
            categoryId: scope.category_id || 0,
            page: pagination.next_page,
            pageSize: pagination.page_size,
            directAddOnly: scope.direct_add_only
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
            direct_add_only: scope.direct_add_only,
            continuation
        }
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
    const total = Math.max(
        items.length,
        clampInteger(paginationSource.total ?? payload.total, 0, Number.MAX_SAFE_INTEGER, items.length)
    );
    const hasMore = paginationSource.has_more === true && total > items.length;
    const cardsShownAfterPage = page * pageSize;
    const canLoadMore = hasMore && cardsShownAfterPage < MAX_CATALOG_CARDS_IN_CHAT;
    const scope = normalizeCatalogScope(
        payload.scope,
        Number(payload.scope?.category_id) || 0,
        payload.direct_add_only === true || payload.scope?.direct_add_only === true
    );
    const continuation = canLoadMore
        ? createCatalogPageToken({
            query: String(payload.query || ''),
            categoryId: scope.category_id || 0,
            page: page + 1,
            pageSize,
            directAddOnly: scope.direct_add_only
        })
        : null;

    return {
        ...payload,
        total,
        coverage: {
            ...(payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {}),
            shown: items.length,
            total,
            remaining: Math.max(0, total - items.length),
            complete: !hasMore && items.length >= total
        },
        pagination: {
            ...paginationSource,
            page,
            page_size: pageSize,
            total,
            returned: items.length,
            has_more: hasMore,
            next_page: hasMore ? page + 1 : null,
            can_load_more: Boolean(continuation),
            chat_card_limit: MAX_CATALOG_CARDS_IN_CHAT,
            truncated_for_chat: hasMore && !continuation
        },
        scope,
        direct_add_only: scope.direct_add_only,
        continuation
    };
}

export function createCatalogPageToken(context = {}) {
    const page = clampInteger(context.page, 2, 10000, 2);
    const pageSize = clampInteger(context.pageSize, 1, MAX_CATALOG_PAGE_SIZE, DEFAULT_CATALOG_PAGE_SIZE);
    const categoryId = clampInteger(context.categoryId, 0, Number.MAX_SAFE_INTEGER, 0);
    const directAddOnly = context.directAddOnly === true;
    const payload = {
        v: 1,
        exp: Math.floor(Date.now() / 1000) + PAGINATION_TOKEN_TTL_SECONDS,
        query: String(context.query || '').trim().slice(0, 160),
        category_id: categoryId,
        page,
        page_size: pageSize,
        ...(directAddOnly ? { direct_add_only: true } : {})
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
            ...(parsed.direct_add_only === true ? { directAddOnly: true } : {})
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
    const total = Math.max(
        safeReturned,
        clampInteger(source.total, 0, Number.MAX_SAFE_INTEGER, safeReturned)
    );
    const hasMore = source.has_more === true || (page * pageSize) < total;

    return {
        total,
        page,
        page_size: pageSize,
        returned: safeReturned,
        has_more: hasMore,
        next_page: hasMore ? clampInteger(source.next_page, page + 1, 10000, page + 1) : null
    };
}

function normalizeCatalogScope(rawScope, categoryId, directAddOnly = false) {
    const source = rawScope && typeof rawScope === 'object' ? rawScope : {};
    const categoryUrl = String(source.category_url || '').trim();

    return {
        category_id: clampInteger(source.category_id ?? categoryId, 0, Number.MAX_SAFE_INTEGER, 0) || null,
        category_name: String(source.category_name || '').trim(),
        category_url: /^https?:\/\//i.test(categoryUrl) || categoryUrl.startsWith('/') ? categoryUrl : '',
        includes_descendants: source.includes_descendants === true,
        unavailable_query_match: source.unavailable_query_match === true,
        ...(source.direct_add_only === true || directAddOnly ? { direct_add_only: true } : {})
    };
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(Math.trunc(parsed), max));
}
