export function isUnavailableQueryMatch(content) {
    return content?.meta?.scope?.unavailable_query_match === true;
}

export function isTerminalCatalogMiss(content) {
    return isUnavailableQueryMatch(content)
        || content?.meta?.scope?.exact_query_miss === true;
}

/**
 * A single product whose normalized name or SKU equals the search identity is
 * sufficient catalogue evidence. Once resolved, a provider must synthesize
 * the answer instead of issuing a later category search that can erase the
 * correct card with an unrelated zero-result page.
 */
export function isResolvedCatalogIdentity(outcome) {
    if (outcome?.name !== 'searchProducts') return false;
    const items = Array.isArray(outcome?.content?.data) ? outcome.content.data : [];
    if (items.length !== 1) return false;

    const query = normalizeIdentity(outcome.query);
    const productName = normalizeIdentity(items[0]?.name);
    const productSku = normalizeIdentity(items[0]?.sku);
    if (query.length < 3) return false;

    return [productName, productSku]
        .filter(identity => identity.length >= 3)
        .some((identity) => {
            const longest = Math.max(query.length, identity.length);
            return editDistance(query, identity) <= Math.max(1, Math.floor(longest * 0.08));
        });
}

export function resolvedCatalogIdentityBlock() {
    return {
        status: 'blocked',
        reason: 'catalog_identity_already_resolved',
        message: 'The exact product identity is already resolved. Answer now from the successful product result already provided; do not search again.'
    };
}

function normalizeIdentity(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function editDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[right.length];
}
