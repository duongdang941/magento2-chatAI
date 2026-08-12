/**
 * Normalize model-provided tool arguments at the Node boundary. Magento only
 * receives scalar, bounded values; configurable selections are carried as a
 * JSON object keyed by the attribute codes returned by Magento itself.
 */
export function normalizeSearchArguments(
    args = {},
    maxResults = 10,
    defaultResults = 5,
    latestShopperMessage = ''
) {
    const normalized = { ...args };
    // responseLanguage guides the model's prose only and must never become a
    // Magento search/filter parameter.
    delete normalized.responseLanguage;
    delete normalized.response_language;
    delete normalized.responseLanguageEvidence;
    delete normalized.response_language_evidence;
    // Scope belongs to the signed WebSocket ticket. Never let model-provided
    // arguments select another store or customer price group.
    delete normalized.customerGroupId;
    delete normalized.customer_group_id;
    delete normalized.storeCode;
    delete normalized.store_code;
    delete normalized.storeId;
    delete normalized.store_id;
    delete normalized.websiteId;
    delete normalized.website_id;
    const boundedDefault = Math.max(1, Math.min(Math.trunc(Number(defaultResults) || 5), maxResults));
    const rawRequestedLimit = Number(normalized.limit || normalized.pageSize || boundedDefault);
    const requestedLimit = Number.isFinite(rawRequestedLimit) ? Math.trunc(rawRequestedLimit) : boundedDefault;
    const limitEvidence = String(normalized.limitEvidence ?? normalized.limit_evidence ?? '').trim();
    const hasValidExplicitLimit = requestedLimit >= 1
        && requestedLimit <= maxResults
        && limitEvidence === String(requestedLimit)
        && numericTokenAppearsInMessage(limitEvidence, latestShopperMessage);
    const safeLimit = requestedLimit === boundedDefault || hasValidExplicitLimit
        ? requestedLimit
        : boundedDefault;
    delete normalized.limitEvidence;
    delete normalized.limit_evidence;
    const requestedPage = Number(normalized.page || 1);

    normalized.limit = safeLimit;
    normalized.pageSize = safeLimit;
    normalized.page = Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1;

    const requestedCategoryId = Number(normalized.categoryId || 0);
    if (Number.isFinite(requestedCategoryId) && requestedCategoryId > 0) {
        normalized.categoryId = Math.trunc(requestedCategoryId);
    } else {
        delete normalized.categoryId;
    }

    for (const field of ['minPrice', 'maxPrice']) {
        const value = Number(normalized[field] || 0);
        if (Number.isFinite(value) && value > 0) {
            normalized[field] = value;
        } else {
            delete normalized[field];
        }
    }

    const directAddOnly = normalized.directAddOnly ?? normalized.direct_add_only;
    if (directAddOnly === true || ['1', 'true'].includes(String(directAddOnly).toLowerCase())) {
        normalized.directAddOnly = true;
    } else {
        delete normalized.directAddOnly;
    }
    delete normalized.direct_add_only;

    const hasExactIdentity = Object.prototype.hasOwnProperty.call(normalized, 'exactIdentity')
        || Object.prototype.hasOwnProperty.call(normalized, 'exact_identity');
    if (hasExactIdentity) {
        normalized.exactIdentity = normalized.exactIdentity === true
            || normalized.exact_identity === true
            || ['1', 'true'].includes(String(normalized.exactIdentity || normalized.exact_identity).toLowerCase());
    } else {
        delete normalized.exactIdentity;
    }
    delete normalized.exact_identity;

    const excludedTerms = Array.isArray(normalized.excludedTerms)
        ? normalized.excludedTerms
        : (Array.isArray(normalized.excluded_terms) ? normalized.excluded_terms : []);
    const safeExcludedTerms = excludedTerms
        .map((term) => String(term || '').trim())
        .filter((term) => term && term.length <= 80)
        .slice(0, 5);
    if (safeExcludedTerms.length > 0) {
        normalized.excludedTerms = JSON.stringify(safeExcludedTerms);
    } else {
        delete normalized.excludedTerms;
    }
    delete normalized.excluded_terms;

    normalized.query = String(normalized.query || '').trim();
    return normalized;
}

function numericTokenAppearsInMessage(number, message) {
    if (!/^\d+$/.test(number)) {
        return false;
    }

    return new RegExp(`(^|[^0-9])${number}(?=[^0-9]|$)`, 'u').test(String(message || ''));
}

export function normalizeAvailabilityArguments(args = {}) {
    const sku = String(args.sku || '').trim();
    const selectedOptions = normalizeSelectedOptions(args.selectedOptions);

    return {
        sku,
        ...(Object.keys(selectedOptions).length > 0
            ? { selectedOptions: JSON.stringify(selectedOptions) }
            : {})
    };
}

export function normalizeAddToCartArguments(args = {}, latestShopperMessage = null) {
    const requestedQty = Number(args.qty ?? 1);
    const qty = Number.isFinite(requestedQty)
        ? Math.max(1, Math.min(Math.trunc(requestedQty), 1000000))
        : 1;
    const hasQtyArgument = Object.prototype.hasOwnProperty.call(args, 'qty');
    const hasShopperEvidence = latestShopperMessage === null
        || numericTokenAppearsInMessage(String(qty), latestShopperMessage);
    // A model can eagerly invent qty=1 even when the shopper did not choose a
    // quantity. Mark that case so Magento can apply the product's actual
    // default (for example a carton increment of 50).
    const useDefaultQty = !hasQtyArgument || !hasShopperEvidence;
    const selectedOptions = normalizeSelectedOptions(args.selectedOptions);

    return {
        sku: String(args.sku || '').trim(),
        qty,
        ...(useDefaultQty ? { useDefaultQty: true } : {}),
        // A regular cart request must never inherit Quote Cart from a prior
        // turn. Quote Cart is opt-in and only accepted from the enum value.
        cartTarget: ['quote', 'quote_cart', 'request_quote'].includes(
            String(args.cartTarget || args.cart_target || '').trim().toLowerCase()
        ) ? 'quote' : 'checkout',
        ...(Object.keys(selectedOptions).length > 0 ? { selectedOptions } : {})
    };
}

export function normalizeRemoveFromCartArguments(args = {}) {
    return {
        action: 'remove',
        sku: String(args.sku || '').trim(),
        cartTarget: ['quote', 'quote_cart', 'request_quote'].includes(
            String(args.cartTarget || args.cart_target || '').trim().toLowerCase()
        ) ? 'quote' : 'checkout'
    };
}

function normalizeSelectedOptions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.entries(value)
        .slice(0, 8)
        .reduce((normalized, [rawCode, rawLabel]) => {
            const code = String(rawCode || '').trim();
            const label = String(rawLabel || '').trim();
            if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) && label && label.length <= 120) {
                normalized[code] = label;
            }
            return normalized;
        }, {});
}
