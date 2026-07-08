/**
 * Tool selection belongs to the model. This module intentionally contains no
 * natural-language intent or keyword detection: language, negation, context,
 * and support requests are handled by the provider from the shared agent
 * instructions. The gateway only enforces technical safety after a call is
 * selected.
 */
export function createCatalogRetrievalPolicy() {
    return Object.freeze({
        shouldForceProductSearch: () => false,
        observeToolCall: () => undefined
    });
}

// Kept as a compatibility export for older tests/integrations. It never
// guesses intent and therefore never forces a catalogue call.
export function requiresFreshProductSearch() {
    return false;
}
