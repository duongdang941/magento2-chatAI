function normalizeQuery(value) {
    return String(value || '').trim();
}

function categoryIdFromArgs(args = {}) {
    return Math.max(0, Math.trunc(Number(args.categoryId ?? args.category_id) || 0));
}

function isLowestPricePreference(args = {}) {
    return String(args.pricePreference ?? args.price_preference ?? '')
        .trim()
        .toLowerCase() === 'lowest';
}

function successfulResultCount(content) {
    if (!content || typeof content !== 'object' || content.error) return null;
    if (String(content.status || '').toLowerCase() === 'error') return null;

    const total = Number(content.meta?.pagination?.total);
    if (Number.isFinite(total) && total >= 0) return Math.trunc(total);
    return Array.isArray(content.data) ? content.data.length : null;
}

/**
 * Preserve a specific catalogue query while the agent narrows a zero-result
 * search to a verified category. Without this continuity an agent can turn a
 * request for one product type into an unrelated dump of the parent category.
 *
 * The state lasts for one shopper turn only and contains no language- or
 * project-specific vocabulary.
 */
export function createCatalogQueryContinuity() {
    let lastMissedQuery = '';
    let lastSuccessfulProductQuery = '';
    // A category-discovery step may only narrow a non-empty product search;
    // it must not erase that search and turn a precise request into an
    // unfiltered category dump. This records transport-level search state,
    // not a locale-dependent interpretation of the shopper's wording.
    let discoverySourceQuery = '';
    let verifiedLeafCategoryIds = new Set();

    return {
        normalize(toolName, args = {}) {
            if (toolName !== 'searchProducts' || !args || typeof args !== 'object') {
                return args;
            }

            const normalized = { ...args };
            const query = normalizeQuery(normalized.query);
            const categoryId = categoryIdFromArgs(normalized);
            const requiredVariantAttributeCode = String(
                normalized.requiredVariantAttributeCode ?? normalized.required_variant_attribute_code ?? ''
            ).trim();
            if (requiredVariantAttributeCode) {
                // Attribute alternatives deliberately browse a verified
                // category by an exact Magento attribute code. Reinstating the
                // prior miss here would turn "other colours" back into a
                // search for the unavailable colour.
                normalized.query = query;
                return normalized;
            }
            const isVerifiedLeafCategory = categoryId > 0 && verifiedLeafCategoryIds.has(categoryId);
            const shouldBrowseBroadLowestPriceScope = categoryId > 0
                && !isVerifiedLeafCategory
                && isLowestPricePreference(normalized)
                && !query;
            if (shouldBrowseBroadLowestPriceScope) {
                // A parent category selected for a lowest-price request is
                // the actual comparison scope. Reinstating the previous
                // free-text term can make that valid parent return zero
                // products and pressure the provider to pick an arbitrary
                // child, hiding cheaper products in sibling categories.
                // This is based solely on the verified category tree and a
                // closed retrieval value, never on category labels or locale.
                normalized.query = '';
                return normalized;
            }
            if (categoryId > 0 && discoverySourceQuery && !query) {
                normalized.query = discoverySourceQuery;
                return normalized;
            }
            if (isVerifiedLeafCategory && lastMissedQuery && (!query || query === lastMissedQuery)) {
                // A verified leaf category is Magento's canonical product
                // family. Browsing it is safer than forcing a shopper-language
                // synonym that may not occur in German catalogue product names.
                normalized.query = '';
            } else if (query) {
                normalized.query = query;
            } else if (lastMissedQuery && categoryId > 0) {
                normalized.query = lastMissedQuery;
            }
            return normalized;
        },

        observe(toolName, args = {}, content = null) {
            if (toolName === 'listCategories') {
                if (!content || typeof content !== 'object' || content.error) return;
                const categories = Array.isArray(content.data) ? content.data : [];
                const parentIds = new Set(categories.map(category => categoryIdFromArgs({
                    categoryId: category?.parent_id
                })).filter(Boolean));
                verifiedLeafCategoryIds = new Set(categories
                    .map(category => ({
                        id: categoryIdFromArgs({ categoryId: category?.id }),
                        count: Math.max(0, Math.trunc(Number(category?.product_count) || 0))
                    }))
                    .filter(category => category.id > 0 && category.count > 0 && !parentIds.has(category.id))
                    .map(category => category.id));
                discoverySourceQuery = String(args?.lookupPurpose || '') === 'product_discovery'
                    ? lastSuccessfulProductQuery
                    : '';
                return;
            }
            if (toolName !== 'searchProducts') return;

            const query = normalizeQuery(args?.query);
            const resultCount = successfulResultCount(content);
            if (resultCount === null) return;
            if (resultCount > 0) {
                lastMissedQuery = '';
                lastSuccessfulProductQuery = query;
            } else if (query) {
                lastMissedQuery = query;
            }
            if (categoryIdFromArgs(args) > 0) {
                discoverySourceQuery = '';
            }
        }
    };
}
