/**
 * A tool round is a provider turn that may execute customer-facing tools.
 * Reserve one extra provider turn so the model can synthesize a response
 * after the final permitted tool result without being able to call a tool.
 */
export function isFinalSynthesisTurn(iteration, maxToolRounds) {
    return Number(iteration) === Number(maxToolRounds);
}

export const FINAL_SYNTHESIS_INSTRUCTION = [
    'FINAL SYNTHESIS TURN: Tool execution is complete and no further tools are available.',
    'Answer the shopper now using only the verified tool results already present in this conversation.',
    'Do not say that you will check, search, look up, refine, or inspect anything.',
    'Do not describe a future action or ask the shopper to wait.',
    'If the verified results contain no match, say that plainly in the shopper\'s language.'
].join(' ');
