import crypto from 'node:crypto';
import { recordGuardrailAudit } from '../gateway/assistant-service-client.js';

export async function reportGuardrailDecision({ config = {}, client = {}, conversationId = 0, decision = {} } = {}) {
    if (config.features?.guardrails_enabled === false) return { status: 'disabled' };
    try {
        await recordGuardrailAudit({
            decision_id: crypto.randomUUID(),
            conversation_id: Math.max(0, Number(conversationId) || 0),
            tool_name: String(decision.toolName || ''),
            decision: decision.allowed === true ? 'allowed' : 'blocked',
            reason: String(decision.reason || 'unknown'),
            risk: String(decision.risk || 'unknown'),
            provider: String(config.provider || ''),
            customer_id: Math.max(0, Number(client.customerId) || 0),
            guest_id: Number(client.customerId) > 0 ? '' : String(client.guestId || '').toLowerCase()
        }, client.catalogScope || null);
        return { status: 'success' };
    } catch {
        return { status: 'unavailable' };
    }
}
