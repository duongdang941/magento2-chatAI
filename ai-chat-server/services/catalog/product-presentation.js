import { buildCatalogProductsPayload } from './catalog-pagination.js';

/**
 * Convert a catalogue tool response into model evidence plus an optional
 * customer presentation. Tool calls may run several times in one assistant
 * turn; callers retain only the last non-empty event and emit it before done.
 */
export function createCatalogToolPresentation(content = {}, args = {}) {
    const catalog = buildCatalogProductsPayload(content, args);
    const event = catalog.items.length > 0 && String(content?.html || '').trim()
        ? {
            type: 'products_html',
            html: String(content.html),
            products: catalog.payload
        }
        : null;

    return { catalog, event };
}

export function emitProductPresentation(ws, event) {
    if (!event || !ws || typeof ws.send !== 'function') return false;
    ws.send(JSON.stringify(event));
    return true;
}

/**
 * A normal assistant turn owns one shopper-facing product result set. Internal
 * retrieval attempts are evidence, not additional grids; the latest accepted
 * presentation replaces earlier candidates.
 */
export function replaceProductPart(parts, incomingPart) {
    if (!Array.isArray(parts) || !incomingPart) return parts;
    const existingIndex = findLastProductPartIndex(parts);
    if (existingIndex >= 0) {
        parts.splice(existingIndex, 1, incomingPart);
    } else {
        parts.push(incomingPart);
    }
    return parts;
}

/** Keep only the final product part while preserving every non-product part. */
export function coalesceProductParts(parts) {
    if (!Array.isArray(parts)) return [];
    const lastProductIndex = findLastProductPartIndex(parts);
    return parts.filter((part, index) => part?.type !== 'products' || index === lastProductIndex);
}

function findLastProductPartIndex(parts) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index]?.type === 'products') return index;
    }
    return -1;
}
