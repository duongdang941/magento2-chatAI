import crypto from 'node:crypto';
import { recordAnalyticsEvent } from '../gateway/assistant-service-client.js';

function productSkus(parts = []) {
    const values = Array.isArray(parts) ? parts : [];
    return [...new Set(values
        .filter((part) => part?.type === 'products' && Array.isArray(part?.payload?.items))
        .flatMap((part) => part.payload.items)
        .map((item) => String(item?.sku || '').trim())
        .filter((sku) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sku))
    )].slice(0, 20);
}

/**
 * Send merchant-enabled attribution telemetry without ever delaying or
 * failing the customer-visible chat response.
 */
export async function reportAssistantCompletion({ config = {}, client = {}, conversationId = 0, messageId = 0, parts = [], durationMs = 0 } = {}) {
    if (config.features?.analytics_attribution_enabled !== true) return { status: 'disabled' };
    const identity = Number(client.customerId) > 0
        ? { customer_id: Number(client.customerId), guest_id: '' }
        : { customer_id: 0, guest_id: String(client.guestId || '').toLowerCase() };
    const common = {
        conversation_id: Math.max(0, Number(conversationId) || 0),
        candidate_set_id: messageId > 0 ? `conversation:${conversationId}:message:${messageId}` : '',
        provider: String(config.provider || '').slice(0, 32),
        model: String(config.model || '').slice(0, 128),
        occurred_at: Math.floor(Date.now() / 1000),
        ...identity
    };
    const events = [{
        ...common,
        event_id: crypto.randomUUID(),
        event_name: 'answer_completed',
        payload: {
            latency_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
            feature_flags: config.features || {}
        }
    }];
    const skus = productSkus(parts);
    if (skus.length) {
        events.push({
            ...common,
            event_id: crypto.randomUUID(),
            event_name: 'recommendation_shown',
            payload: { product_skus: skus, feature_flags: config.features || {} }
        });
    }
    try {
        await Promise.all(events.map((event) => recordAnalyticsEvent(event, client.catalogScope || null)));
        return { status: 'success', count: events.length };
    } catch {
        return { status: 'unavailable' };
    }
}
