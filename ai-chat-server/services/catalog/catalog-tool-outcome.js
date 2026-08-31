export function isUnavailableQueryMatch(content) {
    return content?.meta?.scope?.unavailable_query_match === true;
}

export function isTerminalCatalogMiss(content) {
    return isUnavailableQueryMatch(content)
        || content?.meta?.scope?.exact_query_miss === true;
}

/**
 * An exact catalogue search must not turn a similarly named product into the
 * requested one. This compares stable product identity tokens only; it has
 * no language dictionary and does not depend on a UI label.
 *
 * A one-character typo is allowed per token so an exact search can still
 * recover a genuine spelling slip (for example "Tase" -> "Tasse"), while a
 * changed semantic token (for example "Mein" -> "Unser") is rejected.
 */
export function isStrictExactCatalogIdentityMatch(query, product = {}) {
    const normalizedQuery = normalizeIdentity(query);
    const normalizedSku = normalizeIdentity(product?.sku);
    if (!normalizedQuery) return false;
    if (normalizedSku && normalizedSku === normalizedQuery) return true;

    const queryTokens = identityTokens(normalizedQuery);
    const candidateTokens = identityTokens(product?.name);
    if (queryTokens.length === 0 || candidateTokens.length === 0) return false;

    if (queryTokens.every((queryToken) => candidateTokens.some((candidateToken) => (
        identityTokenMatches(queryToken, candidateToken)
    )))) {
        return true;
    }

    // The provider can accidentally include surrounding shopper prose in an
    // exact-title query. Accept it only when the complete catalogue title is
    // preserved as one contiguous token sequence. This is language-neutral
    // and rejects a reordered, partial, or merely related product title.
    return isEmbeddedExactCatalogIdentityMatch(queryTokens, candidateTokens);
}

/**
 * Choose the identity that still constrains one exact-search refinement.
 * When the two queries retain a meaningful common token, they are the same
 * lexical identity and the original must remain authoritative. When no such
 * evidence survives, the second query may be a genuine catalogue-language
 * translation, so validate against that refined query instead.
 */
export function exactIdentityValidationQuery(rootQuery, refinedQuery) {
    const root = String(rootQuery || '').trim();
    const refined = String(refinedQuery || '').trim();
    if (!root || !refined || normalizeIdentity(root) === normalizeIdentity(refined)) return root || refined;

    const rootTokens = new Set(identityTokens(root));
    const shared = identityTokens(refined).filter(token => rootTokens.has(token));
    const preservesLexicalIdentity = shared.length >= 2 || shared.some(token => token.length >= 4);
    return preservesLexicalIdentity ? root : refined;
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

    if (outcome?.catalogRequest?.exactIdentity === true) {
        return isStrictExactCatalogIdentityMatch(outcome.query, items[0]);
    }

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

function identityTokens(value) {
    return normalizeIdentity(value)
        .split(' ')
        .filter(token => token.length >= 3);
}

function isEmbeddedExactCatalogIdentityMatch(queryTokens, candidateTokens) {
    if (candidateTokens.length > queryTokens.length) return false;
    // A short single term is a product facet, not enough evidence that a
    // longer sentence identifies one specific product.
    if (candidateTokens.length === 1 && candidateTokens[0].length < 8) return false;

    const lastStart = queryTokens.length - candidateTokens.length;
    for (let start = 0; start <= lastStart; start += 1) {
        const matches = candidateTokens.every((candidateToken, offset) => {
            const queryToken = queryTokens[start + offset];
            return identityTokenMatches(queryToken, candidateToken);
        });
        if (matches) return true;
    }

    return false;
}

function identityTokenMatches(queryToken, candidateToken) {
    if (queryToken === candidateToken) return true;
    if (queryToken.length < 4 || candidateToken.length < 4) return false;
    return editDistance(queryToken, candidateToken) <= 1
        || isAdjacentTransposition(queryToken, candidateToken);
}

function isAdjacentTransposition(left, right) {
    if (left.length !== right.length || left.length < 2) return false;
    const mismatches = [];
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) mismatches.push(index);
        if (mismatches.length > 2) return false;
    }
    if (mismatches.length !== 2 || mismatches[1] !== mismatches[0] + 1) return false;
    const [first, second] = mismatches;
    return left[first] === right[second] && left[second] === right[first];
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
