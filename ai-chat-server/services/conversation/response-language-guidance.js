export const RESPONSE_LANGUAGE_AGENT_GUIDANCE = `RESPONSE LANGUAGE CONTRACT:
- Determine the response language from the grammatical/request words in the shopper's latest message. A product name, search term, brand, SKU, quoted phrase, catalogue label, tool result, or store locale must never change the response language.
- For mixed-language requests, keep the language used by the shopper to form the request. Preserve foreign product names and catalogue option labels only as data.
- Every catalogue tool call must set responseLanguage to the BCP-47 language tag selected from that grammatical frame. Keep the same tag through all retrieval rounds in the turn.
- Before emitting customer-visible text, silently verify that headings, explanations, price labels, availability labels, links, and follow-up questions use responseLanguage.`;

export function normalizeResponseLanguage(value) {
    const language = String(value || '').trim();
    if (!language || language.length > 35 || !/^[\p{L}]{2,20}(?:[- ][\p{L}]{2,20}){0,2}$/u.test(language)) {
        return '';
    }
    return language;
}

export function normalizeResponseLanguageEvidence(evidence, shopperMessage, catalogQuery = '') {
    const message = String(shopperMessage || '').toLocaleLowerCase();
    const query = String(catalogQuery || '').toLocaleLowerCase();
    const seen = new Set();

    return (Array.isArray(evidence) ? evidence : [])
        .map(item => String(item || '').trim())
        .filter(item => /^[\p{L}\p{N}'’_-]{1,40}$/u.test(item))
        .filter(item => {
            const normalized = item.toLocaleLowerCase();
            if (seen.has(normalized) || !message.includes(normalized) || query.includes(normalized)) {
                return false;
            }
            seen.add(normalized);
            return true;
        })
        .slice(0, 8);
}

export function responseLanguageInstruction(
    value,
    evidence = [],
    shopperMessage = '',
    catalogQuery = ''
) {
    const safeEvidence = normalizeResponseLanguageEvidence(evidence, shopperMessage, catalogQuery);
    if (safeEvidence.length >= 2) {
        return `RESPONSE LANGUAGE FOR THIS TURN is the language formed by these verified shopper request words: ${JSON.stringify(safeEvidence)}. Use those grammatical words—not the product query, catalogue names, store locale, or a model-supplied language label—to select the language. Write all customer-facing prose and UI labels in that language; preserve foreign catalogue names only as product data.`;
    }

    const language = normalizeResponseLanguage(value);
    if (!language) {
        return 'Use the language formed by the shopper’s grammatical/request words. Ignore catalogue-language evidence when choosing the response language.';
    }

    return `RESPONSE LANGUAGE FOR THIS TURN: ${language}. Write all customer-facing prose and UI labels in this language. Keep foreign catalogue names only as unchanged product data.`;
}
