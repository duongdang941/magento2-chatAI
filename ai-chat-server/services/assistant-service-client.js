import axios from 'axios';
import { createInternalMagentoRequestConfig } from './magento-auth.js';

const MAGENTO_URL = process.env.MAGENTO_API_URL || 'http://afd.test';

async function postInternal(path, payload) {
    const url = `${MAGENTO_URL}${path}`;
    const body = JSON.stringify(payload || {});
    const response = await axios.post(
        url,
        body,
        createInternalMagentoRequestConfig('POST', url, body, { timeout: 15000 })
    );
    return response.data && typeof response.data === 'object'
        ? response.data
        : { status: 'error', message: 'Magento returned an invalid response.' };
}

export function searchStoreKnowledge(query, limit = 5) {
    return postInternal('/afd_ai/chat/knowledge', {
        query: String(query || '').trim().slice(0, 160),
        limit: Math.max(1, Math.min(Math.trunc(Number(limit) || 5), 8))
    });
}

export function createSupportCase(identity, conversationId, args = {}) {
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
    });
}

export function listSupportCases(identity) {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/support', {
        operation: 'list',
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        email: String(identity?.verifiedEmail || '').slice(0, 254),
        verificationToken: String(identity?.verificationToken || '').slice(0, 128),
        verificationSessionId: String(identity?.verificationSessionId || '').slice(0, 128)
    });
}

export function getSupportConversationState(identity, conversationId) {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/supportState', {
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0))
    });
}

export function mutateSupportMessage(identity, conversationId, messageId, operation, content = '') {
    const customerId = Number(identity?.customerId) || 0;
    return postInternal('/afd_ai/chat/supportMessage', {
        customerId,
        guestId: customerId > 0 ? '' : String(identity?.guestId || ''),
        conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0)),
        messageId: Math.max(0, Math.trunc(Number(messageId) || 0)),
        operation: operation === 'delete' ? 'delete' : 'edit',
        content: String(content || '').trim().slice(0, 4000)
    });
}

export function subscribeBackInStock(customerId, sku) {
    return postInternal('/afd_ai/chat/alerts', {
        customerId: Math.max(0, Math.trunc(Number(customerId) || 0)),
        sku: String(sku || '').trim().slice(0, 64)
    });
}
