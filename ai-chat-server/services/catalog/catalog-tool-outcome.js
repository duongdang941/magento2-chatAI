import { normalizeResponseLanguage } from '../conversation/response-language-guidance.js';

export function isUnavailableQueryMatch(content) {
    return content?.meta?.scope?.unavailable_query_match === true;
}

export function isTerminalCatalogMiss(content) {
    return isUnavailableQueryMatch(content)
        || content?.meta?.scope?.exact_query_miss === true;
}

/**
 * A single product whose normalized name equals the search identity is
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
    if (query.length < 5 || productName.length < 5) return false;
    const longest = Math.max(query.length, productName.length);
    return editDistance(query, productName) <= Math.max(1, Math.floor(longest * 0.08));
}

export function resolvedCatalogIdentityBlock() {
    return {
        status: 'blocked',
        reason: 'catalog_identity_already_resolved',
        message: 'The exact product identity is already resolved. Answer now from the successful product result already provided; do not search again.'
    };
}

/**
 * Render the authoritative disabled-product terminal state without another
 * provider round. responseLanguage is selected semantically by the model in
 * the catalogue tool call; no shopper-language keyword regex is involved.
 */
export function unavailableCatalogMessage({ query = '', responseLanguage = '' } = {}) {
    const language = normalizeResponseLanguage(responseLanguage)
        .toLowerCase()
        .split(/[- ]/u)[0];
    const product = safeInlineLabel(query);
    const subject = product ? `“${product}”` : '';
    const templates = {
        de: subject
            ? `Das Produkt ${subject} ist derzeit nicht im aktiven Sortiment verfügbar.`
            : 'Das angefragte Produkt ist derzeit nicht im aktiven Sortiment verfügbar.',
        en: subject
            ? `The product ${subject} is not currently available in the active catalogue.`
            : 'The requested product is not currently available in the active catalogue.',
        es: subject
            ? `El producto ${subject} no está disponible actualmente en el catálogo activo.`
            : 'El producto solicitado no está disponible actualmente en el catálogo activo.',
        fr: subject
            ? `Le produit ${subject} n’est actuellement pas disponible dans le catalogue actif.`
            : 'Le produit demandé n’est actuellement pas disponible dans le catalogue actif.',
        vi: subject
            ? `Hiện sản phẩm ${subject} không có trong danh mục đang được bán.`
            : 'Hiện sản phẩm được yêu cầu không có trong danh mục đang được bán.'
    };

    return templates[language] || templates.en;
}

function safeInlineLabel(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/gu, ' ')
        .replace(/[<>\[\]{}*_`\\]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 160);
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
