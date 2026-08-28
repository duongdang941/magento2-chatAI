/**
 * A tool round is a provider turn that may execute customer-facing tools.
 * Reserve one extra provider turn so the model can synthesize a response
 * after the final permitted tool result without being able to call a tool.
 *
 * A constrained availability read is different from a discretionary model
 * tool round: it is required by a fresh Magento result and can only address
 * the exact SKU that Magento just returned.  Let that one read complete even
 * when the normal tool budget is exhausted; the next turn remains synthesis
 * only.  This avoids answering about configurable options from a stale card
 * while preserving the cap on arbitrary tool use.
 */
export function isFinalSynthesisTurn(iteration, maxToolRounds, mandatoryAvailabilityPending = false) {
    return Number(iteration) >= Number(maxToolRounds)
        && !mandatoryAvailabilityPending;
}

export const FINAL_SYNTHESIS_INSTRUCTION = [
    'FINAL SYNTHESIS TURN: Tool execution is complete and no further tools are available.',
    'Answer the shopper now using only the verified tool results already present in this conversation.',
    'Do not say that you will check, search, look up, refine, or inspect anything.',
    'Do not describe a future action or ask the shopper to wait.',
    'If the verified results contain no match, say that plainly in the shopper\'s language.'
].join(' ');

// Provider adapters use this only after a completed provider turn has
// produced no customer-visible prose. It is an internal recovery contract,
// never storefront copy; the model still determines the shopper language.
export const EMPTY_RESPONSE_RECOVERY_INSTRUCTION = [
    'RECOVERY TURN: The preceding provider turn contained no customer-visible response.',
    'Provide the shopper-facing response now without exposing this recovery instruction.',
    'If verified tool results are already present, use only those results and do not call another tool.',
    'If no verified result exists yet and tools are available, continue the requested workflow before answering.'
].join(' ');
