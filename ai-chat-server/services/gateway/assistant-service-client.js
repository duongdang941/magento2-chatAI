import axios from 'axios';
import { createInternalMagentoRequestConfig } from './magento-auth.js';
import { normalizeCatalogScope } from '../catalog/catalog-scope.js';
import { resolveMagentoBaseUrl } from './magento-url.js';

async function postInternal(path, payload, catalogScope = null) {
    const url = `${resolveMagentoBaseUrl(catalogScope)}${path}`;
    const body = JSON.stringify({
        ...(payload || {}),
        // The browser never supplies this field. It comes from the
        // Magento-signed WebSocket ticket and lets Magento select the same
        // store view for direct internal endpoints as it does for REST tools.
        storeCode: normalizeCatalogScope(catalogScope)?.storeCode || ''
    });
    const response = await axios.post(
        url,
        body,
        createInternalMagentoRequestConfig('POST', url, body, { timeout: 15000 })
    );
    return response.data && typeof response.data === 'object'
        ? response.data
        : { status: 'error', message: 'Magento returned an invalid response.' };
}

export function knowledgeSearchPayload(query, limit = 5, catalogScope = null) {
    const scope = normalizeCatalogScope(catalogScope);
    return {
        query: String(query || '').trim().slice(0, 160),
        limit: Math.max(1, Math.min(Math.trunc(Number(limit) || 5), 8)),
        // This is copied only from the Magento-signed WebSocket ticket. Model
        // tool arguments never participate in selecting KB customer scope.
        customerGroupId: scope?.customerGroupId || 0
    };
}

export function searchStoreKnowledge(query, limit = 5, catalogScope = null) {
    return postInternal('/afd_ai/chat/knowledge', knowledgeSearchPayload(query, limit, catalogScope), catalogScope);
}

export function createSupportCase(identity, conversationId, args = {}, catalogScope = identity?.catalogScope || null) {
    const customerId = Number(identity?.customerId) || 0;
    const guestId = customerId > 0 ? '' : String(identity?.guestId || '');
    return postInternal('/afd_ai/chat/support', {
        customerId,
        guestId,
        conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0)),
        category: String(args.category || 'general').slice(0, 32),
        priority: String(args.priority || 'normal').slice(0, 16),
        subject: String(args.subject || '').slice(0, 255),
        summary: String(args.summary || '').slice(0, 4000),
        email: String(identity?.verifiedEmail || '').slice(0, 254),
        verificationToken: String(identity?.verificationToken || '').slice(0, 128),
        verificationSessionId: String(identity?.verificationSessionId || '').slice(0, 128),
        context: args.context && typeof args.context === 'object' && !Array.isArray(args.context)
            ? args.context
            : {}
    }, catalogScope);
}

export function listSupportCases(identity, catalogScope = identity?.catalogScope || null) {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/support', {
        operation: 'list',
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        email: String(identity?.verifiedEmail || '').slice(0, 254),
        verificationToken: String(identity?.verificationToken || '').slice(0, 128),
        verificationSessionId: String(identity?.verificationSessionId || '').slice(0, 128)
    }, catalogScope);
}

export function getSupportConversationState(identity, conversationId, catalogScope = identity?.catalogScope || null) {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/supportState', {
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0))
    }, catalogScope);
}

export function mutateSupportMessage(identity, conversationId, messageId, operation, content = '', catalogScope = identity?.catalogScope || null) {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/supportMessage', {
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0)),
        messageId: Math.max(0, Math.trunc(Number(messageId) || 0)),
        operation: operation === 'delete' ? 'delete' : 'edit',
        content: String(content || '').trim().slice(0, 4000)
    }, catalogScope);
}

export function subscribeBackInStock(customerId, sku, catalogScope = null) {
    return postInternal('/afd_ai/chat/alerts', {
        customerId: Math.max(0, Math.trunc(Number(customerId) || 0)),
        sku: String(sku || '').trim().slice(0, 64)
    }, catalogScope);
}

/** Persist a bounded, idempotent analytics event through Magento's signed internal endpoint. */
export function recordAnalyticsEvent(event = {}, catalogScope = null) {
    const payload = event && typeof event === 'object' ? event : {};
    return postInternal('/afd_ai/chat/analytics', {
        event_id: String(payload.event_id || '').slice(0, 64),
        event_name: String(payload.event_name || '').slice(0, 64),
        conversation_id: Math.max(0, Math.trunc(Number(payload.conversation_id) || 0)),
        candidate_set_id: String(payload.candidate_set_id || '').slice(0, 128),
        customer_id: Math.max(0, Math.trunc(Number(payload.customer_id) || 0)),
        guest_id: String(payload.guest_id || '').slice(0, 64),
        provider: String(payload.provider || '').slice(0, 32),
        model: String(payload.model || '').slice(0, 128),
        occurred_at: Math.max(0, Math.trunc(Number(payload.occurred_at) || 0)),
        payload: payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
            ? payload.payload
            : {}
    }, catalogScope);
}

export function recordGuardrailAudit(event = {}, catalogScope = null) {
    const payload = event && typeof event === 'object' ? event : {};
    return postInternal('/afd_ai/chat/guardrailAudit', {
        decision_id: String(payload.decision_id || '').slice(0, 64),
        conversation_id: Math.max(0, Math.trunc(Number(payload.conversation_id) || 0)),
        tool_name: String(payload.tool_name || '').slice(0, 80),
        decision: payload.decision === 'allowed' ? 'allowed' : 'blocked',
        reason: String(payload.reason || '').slice(0, 80),
        risk: String(payload.risk || '').slice(0, 32),
        provider: String(payload.provider || '').slice(0, 32),
        customer_id: Math.max(0, Math.trunc(Number(payload.customer_id) || 0)),
        guest_id: String(payload.guest_id || '').slice(0, 64)
    }, catalogScope);
}
