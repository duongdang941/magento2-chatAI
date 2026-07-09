import { sanitizeCustomerResponse } from './customer-response-sanitizer.js';
import { normalizeOrderAddressFormPart } from '../customer/order-address-form.js';
import { coalesceProductParts } from '../catalog/product-presentation.js';
import { contextBytes, fitHistoryToBudget, truncateUtf8Middle } from '../orchestration/context-budget.js';

const CATALOG_CONTEXT_MARKER = '[CATALOG_CONTEXT:';

export function createConversationHistoryCodec({ maxModelHistoryMessages = 16 } = {}) {
    function extractTextFromParts(parts) {
        return parts
            .filter((part) => part && (part.type || 'text') === 'text')
            .map((part) => part.raw || part.text || '')
            .filter(Boolean)
            .join('\n\n');
    }

    function guestHistoryMessagesFromClient(history) {
        if (!Array.isArray(history)) return [];

        return history
            .slice(-maxModelHistoryMessages)
            .map((message) => normalizeGuestHistoryMessage(message))
            .filter(Boolean);
    }

    function normalizeGuestHistoryMessage(message) {
        const role = message?.role === 'user' ? 'user' : 'assistant';
        const sourceParts = Array.isArray(message?.parts) ? message.parts : [];
        const rawText = sourceParts.length > 0
            ? sourceParts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
            : String(message?.content || message?.text || '');
        const text = rawText.replace(/\n*\[CATALOG_CONTEXT:[\s\S]*$/u, '').trim();
        const imageParts = sourceParts
            .filter((part) => part?.type === 'image' && /^https?:\/\//i.test(String(part.url || '')))
            .map((part) => ({
                type: 'image',
                url: String(part.url),
                alt: String(part.alt || 'Generated image').slice(0, 400),
                prompt: String(part.prompt || '').slice(0, 4000),
                size: String(part.size || '').slice(0, 32),
                quality: String(part.quality || '').slice(0, 16)
            }));
        const guestOrderAccessParts = sourceParts
            .filter((part) => part?.type === 'guest_order_access')
            .slice(0, 1)
            .map((part) => ({
                type: 'guest_order_access',
                state: 'email',
                purpose: part?.purpose === 'support' ? 'support' : 'order',
                ...(Number(part?.expires_at ?? part?.expiresAt) > 0
                    ? { expires_at: Number(part?.expires_at ?? part?.expiresAt) }
                    : {})
            }));
        const addressFormParts = sourceParts
            .filter((part) => part?.type === 'order_address_form')
            .map((part) => normalizeOrderAddressFormPart(part))
            .filter(Boolean);

        if (!text && (role === 'user' || (
            imageParts.length === 0
            && guestOrderAccessParts.length === 0
            && addressFormParts.length === 0
        ))) return null;

        if (role === 'user') {
            return { role: 'user', content: text, attachments: [] };
        }

        return {
            role: 'assistant',
            content: text,
            parts: [
                ...(text ? [{ type: 'text', raw: text }] : []),
                ...imageParts,
                ...guestOrderAccessParts,
                ...addressFormParts
            ]
        };
    }

    function normalizeStoredAssistantMessage(sourceMessage) {
        let message = sourceMessage;
        let interrupted = message?.interrupted === true;
        let stoppedAfterSeconds = Math.max(0, Math.floor(Number(message?.stopped_after_seconds) || 0));

        if (message.role !== 'user' && !Array.isArray(message.parts) && typeof message.content === 'string') {
            try {
                const storedPayload = JSON.parse(message.content);
                if (storedPayload?.format === 'afd_ai_chat_message' && Array.isArray(storedPayload.parts)) {
                    interrupted = storedPayload.interrupted === true;
                    stoppedAfterSeconds = Math.max(
                        0,
                        Math.floor(Number(storedPayload.stopped_after_seconds) || 0)
                    );
                    message = {
                        ...message,
                        content: storedPayload.text || message.content,
                        parts: storedPayload.parts,
                        source: storedPayload.source === 'support_agent' ? 'support_agent' : '',
                        sender_label: storedPayload.source === 'support_agent'
                            ? String(storedPayload.sender_label || 'Support team').slice(0, 80)
                            : '',
                        interrupted,
                        stopped_after_seconds: stoppedAfterSeconds
                    };
                }
            } catch {
                // Legacy assistant rows can contain plain text.
            }
        }

        if (message.role === 'user') return normalizeStoredUserMessage(message);

        const metadata = normalizeStoredMessageMetadata(message);

        if (Array.isArray(message.parts) && message.parts.length > 0) {
            return {
                ...metadata,
                role: 'assistant',
                content: sanitizeCustomerResponse(message.content || extractTextFromParts(message.parts)),
                source: message.source === 'support_agent' ? 'support_agent' : '',
                sender_label: message.source === 'support_agent'
                    ? String(message.sender_label || 'Support team').slice(0, 80)
                    : '',
                ...(interrupted ? {
                    interrupted: true,
                    stopped_after_seconds: stoppedAfterSeconds
                } : {}),
                parts: message.parts.map((part, index) => normalizeStoredPart(part, message, index))
            };
        }

        const content = sanitizeCustomerResponse(message.content || '');
        return {
            ...metadata,
            role: 'assistant',
            content,
            ...(interrupted ? {
                interrupted: true,
                stopped_after_seconds: stoppedAfterSeconds
            } : {}),
            parts: [{ id: `${message.entity_id}-0`, type: 'text', raw: content, html: content }]
        };
    }

    function normalizeStoredUserMessage(message) {
        const attachmentCandidates = Array.isArray(message.attachments)
            ? message.attachments
            : (message.attachment && typeof message.attachment === 'object' ? [message.attachment] : []);
        return {
            ...normalizeStoredMessageMetadata(message, false),
            role: 'user',
            content: message.content || '',
            attachments: attachmentCandidates
                .filter((attachment) => attachment
                    && /^image\/(jpeg|png|webp)$/.test(String(attachment.mime_type || '').toLowerCase()))
                .map((attachment) => normalizeStoredAttachment(attachment))
                .filter(Boolean)
        };
    }

    function normalizeStoredMessageMetadata(message, includeFeedback = true) {
        const entityId = Number(message?.entity_id) || null;
        const metadata = {
            entity_id: entityId,
            is_edited: message?.is_edited === true,
            edited_at: String(message?.edited_at || '').slice(0, 32),
            is_deleted: message?.is_deleted === true,
            deleted_at: String(message?.deleted_at || '').slice(0, 32)
        };
        if (!includeFeedback) return metadata;

        const rating = String(message?.feedback || '').toLowerCase();
        return {
            ...metadata,
            feedback: ['positive', 'negative'].includes(rating) ? rating : '',
            feedback_reason: String(message?.feedback_reason || '').slice(0, 64),
            feedback_comment: String(message?.feedback_comment || '').slice(0, 1000)
        };
    }

    function normalizeStoredAttachment(attachment) {
        const type = String(attachment.mime_type).toLowerCase();
        if (attachment.url) {
            return {
                name: attachment.name || 'product-image',
                type,
                size: Number(attachment.size) || 0,
                previewUrl: String(attachment.url)
            };
        }
        if (!attachment.data) return null;
        return {
            name: attachment.name || 'product-image',
            type,
            size: Math.floor(String(attachment.data).length * 0.75),
            previewUrl: `data:${type};base64,${attachment.data}`
        };
    }

    function normalizeStoredPart(part, message, index) {
        const id = part.id || `${message.entity_id}-${index}`;
        if (part.type === 'products') {
            return { id, type: 'products', html: part.html || '', payload: part.payload || null };
        }
        if (part.type === 'image' && /^https?:\/\//i.test(String(part.url || ''))) {
            return {
                id,
                type: 'image',
                url: String(part.url),
                alt: String(part.alt || 'Generated image').slice(0, 400),
                prompt: String(part.prompt || '').slice(0, 4000),
                size: String(part.size || ''),
                quality: String(part.quality || '')
            };
        }
        if (part.type === 'guest_order_access') {
            return {
                id,
                type: 'guest_order_access',
                state: 'email',
                purpose: part?.purpose === 'support' ? 'support' : 'order',
                ...(Number(part?.expires_at ?? part?.expiresAt) > 0
                    ? { expires_at: Number(part?.expires_at ?? part?.expiresAt) }
                    : {})
            };
        }
        if (part.type === 'order_address_form') {
            const form = normalizeOrderAddressFormPart(part);
            if (form) return { id, ...form };
        }
        const raw = sanitizeCustomerResponse(part.raw || part.text || '');
        return { id, type: 'text', raw, html: raw };
    }

    function trimHistoryForModel(
        history,
        requestedLimit = maxModelHistoryMessages,
        requestedTokenBudget = 12000,
        onStats = null
    ) {
        if (!Array.isArray(history)) return [];

        const parsedLimit = Number(requestedLimit);
        const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(Math.trunc(parsedLimit), 40))
            : maxModelHistoryMessages;

        let latestCatalogContext = '';
        const normalized = history
            .filter((message) => message && ['user', 'assistant', 'model'].includes(message.role))
            .map((message) => {
                const role = message.role === 'assistant' ? 'model' : message.role;
                const text = Array.isArray(message.parts)
                    ? message.parts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
                    : String(message.content || message.text || '');
                const split = splitCatalogContext(text);
                if (split.catalogContext) latestCatalogContext = split.catalogContext;
                const trimmed = split.visibleText.trim();
                return trimmed ? { role, parts: [{ text: trimmed }] } : null;
            })
            .filter(Boolean);

        const parsedTokenBudget = Number(requestedTokenBudget);
        const tokenBudget = Number.isFinite(parsedTokenBudget)
            ? Math.max(512, Math.min(Math.trunc(parsedTokenBudget), 64000))
            : 12000;
        const maxMemoryBytes = Math.min(8000, Math.floor((tokenBudget * 4) / 3));
        const memoryText = latestCatalogContext
            ? truncateUtf8Middle(latestCatalogContext, maxMemoryBytes)
            : '';
        const memoryMessage = memoryText
            ? { role: 'model', parts: [{ text: memoryText }] }
            : null;
        const memoryTokens = memoryMessage ? Math.ceil(contextBytes(memoryMessage) / 4) : 0;
        const recentHistory = fitHistoryToBudget(normalized, {
            maxMessages: limit,
            maxTokens: Math.max(64, tokenBudget - memoryTokens)
        });

        const modelHistory = memoryMessage ? [memoryMessage, ...recentHistory] : recentHistory;
        if (typeof onStats === 'function') {
            const legacyView = normalized.slice(-limit);
            const rawBytes = contextBytes(legacyView);
            const modelBytes = contextBytes(modelHistory);
            onStats({
                rawBytes,
                modelBytes,
                savedBytes: Math.max(0, rawBytes - modelBytes),
                rawEstimatedTokens: Math.ceil(rawBytes / 4),
                modelEstimatedTokens: Math.ceil(modelBytes / 4),
                reductionRatio: rawBytes > 0 ? Math.max(0, (rawBytes - modelBytes) / rawBytes) : 0,
                inputMessages: normalized.length,
                modelMessages: modelHistory.length,
                latestCatalogMemory: Boolean(memoryMessage),
                budgetTokens: tokenBudget
            });
        }
        return modelHistory;
    }

    function splitCatalogContext(value) {
        const text = String(value || '');
        const markerIndex = text.lastIndexOf(CATALOG_CONTEXT_MARKER);
        if (markerIndex < 0) return { visibleText: text, catalogContext: '' };

        return {
            visibleText: text.slice(0, markerIndex).trimEnd(),
            catalogContext: text.slice(markerIndex).trim()
        };
    }

    function buildAssistantStoragePayload(parts, metadata = {}) {
        const normalizedParts = coalesceProductParts(parts
            .map((part) => normalizeStoragePart(part))
            .filter(Boolean));
        if (normalizedParts.length === 0) return '';

        const payload = {
            version: 1,
            format: 'afd_ai_chat_message',
            text: extractTextFromParts(normalizedParts),
            parts: normalizedParts
        };
        if (metadata.interrupted === true) {
            payload.interrupted = true;
            payload.stopped_after_seconds = Math.max(
                0,
                Math.floor(Number(metadata.stopped_after_seconds) || 0)
            );
        }
        return JSON.stringify(payload);
    }

    function normalizeStoragePart(part) {
        if (!part?.type) return null;
        if (part.type === 'products') {
            const html = (part.html || '').trim();
            const payload = part.payload && typeof part.payload === 'object' ? part.payload : null;
            if (!payload && !html) return null;
            return payload ? { type: 'products', payload } : { type: 'products', html };
        }
        if (part.type === 'image') {
            const url = String(part.url || '').trim();
            if (!/^https?:\/\//i.test(url)) return null;
            return {
                type: 'image',
                url,
                alt: String(part.alt || 'Generated image').slice(0, 400),
                prompt: String(part.prompt || '').slice(0, 4000),
                size: String(part.size || '').slice(0, 32),
                quality: String(part.quality || '').slice(0, 16)
            };
        }
        if (part.type === 'guest_order_access') {
            return {
                type: 'guest_order_access',
                state: 'email',
                purpose: part?.purpose === 'support' ? 'support' : 'order',
                ...(Number(part?.expires_at ?? part?.expiresAt) > 0
                    ? { expires_at: Number(part?.expires_at ?? part?.expiresAt) }
                    : {})
            };
        }
        if (part.type === 'order_address_form') return normalizeOrderAddressFormPart(part);
        const raw = part.raw || part.text || '';
        return raw ? { type: 'text', raw } : null;
    }

    function buildConversationTitle(sourceText, options = {}) {
        if (options.hasImage && (!sourceText || sourceText === 'Đã gửi hình ảnh')) return 'Ảnh sản phẩm';

        let title = String(sourceText || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!title) return 'New Chat';

        title = title
            .replace(/^(xin chào|chào|hello|hi|hey)[,.\s]+/i, '')
            .replace(/^(bạn có thể|ban co the|hãy|hay|làm ơn|lam on|giúp tôi|giup toi|giúp mình|giup minh|cho tôi|cho toi|cho mình|cho minh|tôi muốn|toi muon|mình muốn|minh muon|tôi cần|toi can|show me|find me|help me)\s+/i, '')
            .replace(/[?.!,;:]+$/g, '')
            .trim();
        if (!title) return 'New Chat';

        const words = title.split(/\s+/).slice(0, 10).join(' ');
        return words.length <= 58 ? words : `${words.slice(0, 55).trim()}...`;
    }

    return {
        buildAssistantStoragePayload,
        buildConversationTitle,
        extractTextFromParts,
        guestHistoryMessagesFromClient,
        normalizeStoredAssistantMessage,
        trimHistoryForModel
    };
}
