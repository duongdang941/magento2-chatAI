/**
 * Last-line protection for customer-facing model prose.
 *
 * The system prompts prohibit internal terminology, but a model can still
 * occasionally echo a tool name. Keep a small, explicit deny-list here and
 * process it as a stream so a name split across provider chunks is never
 * rendered or persisted.
 */
const INTERNAL_IDENTIFIERS = [
    'getProductAvailability',
    'searchProducts',
    'listCategories',
    'updateCartItem',
    'removeFromCart',
    'getCustomerInfo',
    'getRecentOrders',
    'getGuestOrders',
    'getGuestOrderDetails',
    'getOrderDetails',
    'updateGuestOrderAddress',
    'updateOrderAddress',
    'getCustomerAddresses',
    'updateCustomerAddress',
    'getActiveCoupons',
    'addToCart',
    'CATALOG_CONTEXT'
];

const internalIdentifierPattern = new RegExp(
    `\\b(?:${INTERNAL_IDENTIFIERS.join('|')})\\b`,
    'gi'
);
const maxIdentifierLength = Math.max(...INTERNAL_IDENTIFIERS.map((value) => value.length));
// Magento installations that still use utf8mb3 cannot persist four-byte
// Unicode characters (most emoji/decorative pictograms). Remove them before
// streaming and persistence so the history never turns them into `?` bytes.
const unsupportedUnicodePattern = /[\u{10000}-\u{10FFFF}]/gu;
// Older rows may already contain replacement question marks immediately before
// a Markdown link. Remove only that malformed boundary, never normal prose
// question marks.
const malformedIconBoundaryPattern = /\?{2,}(?=\s*(?:\[[^\]\n]+\]\(|https?:\/\/))/gu;

export function sanitizeCustomerResponse(value) {
    return String(value || '')
        .replace(internalIdentifierPattern, '')
        .replace(unsupportedUnicodePattern, '')
        .replace(malformedIconBoundaryPattern, '')
        // Removing an identifier can leave an awkward double space before
        // punctuation; normalize only the affected boundary, not Markdown.
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1');
}

export function createCustomerResponseStreamSanitizer() {
    let pending = '';
    let hasEmittedText = false;

    const prepareForEmission = (value) => {
        let safeText = sanitizeCustomerResponse(value);
        // A response that starts with a removed identifier should not begin
        // with the identifier's leftover whitespace. Never trim later chunks:
        // their leading space can be meaningful between streamed words.
        if (!hasEmittedText) {
            safeText = safeText.trimStart();
        }
        if (safeText) {
            hasEmittedText = true;
        }
        return safeText;
    };

    return {
        push(value) {
            pending += String(value || '');
            const safeLength = Math.max(0, pending.length - (maxIdentifierLength - 1));
            if (safeLength === 0) return '';

            const safeText = pending.slice(0, safeLength);
            pending = pending.slice(safeLength);
            return prepareForEmission(safeText);
        },

        flush() {
            const safeText = prepareForEmission(pending);
            pending = '';
            return safeText;
        },

        discard() {
            pending = '';
            hasEmittedText = false;
        }
    };
}
