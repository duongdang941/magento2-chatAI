import axios from 'axios';
import { summarizeError } from './error-summary.js';
import { createInternalMagentoRequestConfig } from './magento-auth.js';

const MAGENTO_URL = process.env.MAGENTO_API_URL || 'http://afd.test';

function postInternal(path, payload) {
    const url = `${MAGENTO_URL}${path}`;
    const body = JSON.stringify(payload);
    return axios.post(url, body, createInternalMagentoRequestConfig('POST', url, body));
}

function getInternal(path) {
    const url = `${MAGENTO_URL}${path}`;
    return axios.get(url, createInternalMagentoRequestConfig('GET', url, '', { contentType: false }));
}

function normalizeMessagePage(payload) {
    if (Array.isArray(payload)) {
        // Magento Web API serializes an associative PHP array return value as
        // an ordered JSON array: [messages, has_more, next_before_message_id].
        return {
            messages: Array.isArray(payload[0]) ? payload[0] : [],
            has_more: payload[1] === true,
            next_before_message_id: Number(payload[2]) || null
        };
    }

    if (payload && typeof payload === 'object') {
        return {
            messages: Array.isArray(payload.messages) ? payload.messages : [],
            has_more: payload.has_more === true,
            next_before_message_id: Number(payload.next_before_message_id) || null
        };
    }

    return { messages: [], has_more: false, next_before_message_id: null };
}

export function conversationExists(conversations, conversationId) {
    const targetId = Number(conversationId);
    return Array.isArray(conversations) && conversations.some((conversation) => Number(conversation.id) === targetId);
}

export function normalizeConversationPage(payload, requestedPage = 1) {
    const fallback = {
        conversations: [],
        hasMore: false,
        nextPage: null,
        page: Math.max(1, Number(requestedPage) || 1)
    };

    // Magento's Web API encodes the tuple returned by the service as an
    // ordered JSON array: [items, has_more, next_page]. Keep compatibility
    // with the former unpaged array response during a rolling deployment.
    if (Array.isArray(payload)) {
        if (Array.isArray(payload[0])) {
            return {
                conversations: payload[0],
                hasMore: payload[1] === true,
                nextPage: Number(payload[2]) || null,
                page: Math.max(1, Number(requestedPage) || 1)
            };
        }

        return { ...fallback, conversations: payload };
    }

    if (payload && typeof payload === 'object') {
        const conversations = Array.isArray(payload.conversations)
            ? payload.conversations
            : (Array.isArray(payload.items) ? payload.items : []);
        return {
            conversations,
            hasMore: payload.has_more === true || payload.hasMore === true,
            nextPage: Number(payload.next_page ?? payload.nextPage) || null,
            page: Math.max(1, Number(payload.page) || Number(requestedPage) || 1)
        };
    }

    return fallback;
}

function normalizeConversation(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return Number(payload.id) > 0 ? payload : null;
    }

    if (Array.isArray(payload) && Number(payload[0]) > 0) {
        return {
            id: Number(payload[0]),
            title: String(payload[1] || ''),
            created_at: String(payload[2] || ''),
            updated_at: String(payload[3] || '')
        };
    }

    return null;
}

// ==================== CONVERSATIONS ====================

/**
 * Create a new conversation via Magento REST API
 */
export async function createConversation(customerId, title = 'New Chat') {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/create', {
            customerId,
            title: title.substring(0, 255)
        });
        return response.data;
    } catch (error) {
        console.error('createConversation error:', summarizeError(error));
        throw error;
    }
}

/**
 * Return a bounded page of conversations for a customer, newest first.
 */
export async function listConversations(customerId, page = 1) {
    try {
        const requestedPage = Math.max(1, Number(page) || 1);
        const response = await getInternal(
            `/rest/V1/afd-ai/conversations/list/${customerId}?pageSize=20&currentPage=${requestedPage}`
        );
        return normalizeConversationPage(response.data, requestedPage);
    } catch (error) {
        console.error('listConversations error:', summarizeError(error));
        return normalizeConversationPage(null, page);
    }
}

/**
 * Load messages for a conversation (with ownership check in Magento)
 */
export async function loadMessages(conversationId, customerId, beforeMessageId = null) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/messages', {
            conversationId,
            customerId,
            beforeMessageId: Number.isInteger(Number(beforeMessageId)) && Number(beforeMessageId) > 0
                ? Number(beforeMessageId)
                : null,
            pageSize: 50
        });
        return normalizeMessagePage(response.data);
    } catch (error) {
        console.error('loadMessages error:', summarizeError(error));
        return { messages: [], has_more: false, next_before_message_id: null };
    }
}

/**
 * Save a message to a conversation via Magento REST API
 */
export async function saveMessage(conversationId, customerId, role, content, attachment = null) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/save-message', {
            conversationId,
            customerId,
            role,
            content,
            attachment
        });
        return response.data;
    } catch (error) {
        console.error('saveMessage error:', summarizeError(error));
        throw error;
    }
}

/**
 * Replace a historical customer turn by removing that user message and the
 * obsolete response branch before the gateway persists its replacement.
 */
export async function truncateConversationFromMessage(conversationId, customerId, fromMessageId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/truncate-from-message', {
            conversationId: Number(conversationId),
            customerId: Number(customerId),
            fromMessageId: Number(fromMessageId)
        });
        return response.data === true;
    } catch (error) {
        console.error('truncateConversationFromMessage error:', summarizeError(error));
        return false;
    }
}

/**
 * Delete a conversation and its messages (ownership checked in Magento)
 */
export async function deleteConversation(conversationId, customerId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/delete', {
            conversationId,
            customerId
        });
        return response.data;
    } catch (error) {
        console.error('deleteConversation error:', summarizeError(error));
        return false;
    }
}

/**
 * Touch conversation (update updated_at timestamp)
 */
export async function touchConversation(conversationId) {
    try {
        await postInternal('/rest/V1/afd-ai/conversations/touch', { conversationId });
        return true;
    } catch (error) {
        console.error('touchConversation error:', summarizeError(error));
        return false;
    }
}

/**
 * Verify conversation ownership (load to check)
 */
export async function getConversation(conversationId, customerId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/get', {
            conversationId: Number(conversationId),
            customerId: Number(customerId)
        });
        return normalizeConversation(response.data);
    } catch (error) {
        console.error('getConversation error:', summarizeError(error));
        return null;
    }
}

/**
 * Update conversation title via Magento REST API
 */
export async function updateConversationTitle(conversationId, customerId, title) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/conversations/update-title', {
            conversationId,
            customerId,
            title: title.substring(0, 255)
        });
        return !!response.data;
    } catch (error) {
        console.error('updateConversationTitle error:', summarizeError(error));
        return false;
    }
}

// ==================== PERSISTED GUEST CONVERSATIONS ====================
// The caller receives `guestId` exclusively from a signed WebSocket ticket.
// It is a one-way Magento-session digest, never a raw session ID or a browser value.
export async function createGuestConversation(guestId, title = 'New Chat') {
    const response = await postInternal('/rest/V1/afd-ai/guest-conversations/create', {
        guestId,
        title: String(title).substring(0, 255)
    });
    return response.data;
}

export async function listGuestConversations(guestId, page = 1) {
    try {
        const requestedPage = Math.max(1, Number(page) || 1);
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/list', {
            guestId,
            pageSize: 20,
            currentPage: requestedPage
        });
        return normalizeConversationPage(response.data, requestedPage);
    } catch (error) {
        console.error('listGuestConversations error:', summarizeError(error));
        return normalizeConversationPage(null, page);
    }
}

export async function getGuestConversation(conversationId, guestId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/get', { conversationId, guestId });
        return normalizeConversation(response.data);
    } catch (error) {
        console.error('getGuestConversation error:', summarizeError(error));
        return null;
    }
}

export async function loadGuestMessages(conversationId, guestId, beforeMessageId = null) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/messages', {
            conversationId,
            guestId,
            beforeMessageId: Number(beforeMessageId) > 0 ? Number(beforeMessageId) : null,
            pageSize: 50
        });
        return normalizeMessagePage(response.data);
    } catch (error) {
        console.error('loadGuestMessages error:', summarizeError(error));
        return { messages: [], has_more: false, next_before_message_id: null };
    }
}

export async function saveGuestMessage(conversationId, guestId, role, content, attachment = null) {
    const response = await postInternal('/rest/V1/afd-ai/guest-conversations/save-message', {
        conversationId, guestId, role, content, attachment
    });
    return response.data;
}

/** Preserve edit/regenerate semantics for durable guest conversations. */
export async function truncateGuestConversationFromMessage(conversationId, guestId, fromMessageId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/truncate-from-message', {
            conversationId: Number(conversationId),
            guestId,
            fromMessageId: Number(fromMessageId)
        });
        return response.data === true;
    } catch (error) {
        console.error('truncateGuestConversationFromMessage error:', summarizeError(error));
        return false;
    }
}

export async function deleteGuestConversation(conversationId, guestId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/delete', { conversationId, guestId });
        return response.data === true;
    } catch (error) {
        console.error('deleteGuestConversation error:', summarizeError(error));
        return false;
    }
}

export async function touchGuestConversation(conversationId, guestId) {
    try {
        await postInternal('/rest/V1/afd-ai/guest-conversations/touch', { conversationId, guestId });
        return true;
    } catch (error) {
        console.error('touchGuestConversation error:', summarizeError(error));
        return false;
    }
}

export async function updateGuestConversationTitle(conversationId, guestId, title) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/update-title', {
            conversationId, guestId, title: String(title).substring(0, 255)
        });
        return response.data === true;
    } catch (error) {
        console.error('updateGuestConversationTitle error:', summarizeError(error));
        return false;
    }
}

export async function deleteGuestConversations(guestId) {
    try {
        const response = await postInternal('/rest/V1/afd-ai/guest-conversations/delete-all', { guestId });
        return response.data === true;
    } catch (error) {
        console.error('deleteGuestConversations error:', summarizeError(error));
        return false;
    }
}

/** Verify Magento through the cheap HMAC-authenticated liveness contract. */
export async function pingMagento() {
    try {
        const response = await getInternal('/rest/V1/afd-ai/health');
        if (response.data !== true) return false;
        return true;
    } catch (error) {
        console.error('Magento health check failed:', summarizeError(error));
        return false;
    }
}
