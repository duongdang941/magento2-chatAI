import { sanitizeCustomerResponse } from './customer-response-sanitizer.js';
import { normalizeOrderAddressFormPart } from '../customer/order-address-form.js';
import { coalesceProductParts } from '../catalog/product-presentation.js';
import { contextBytes, fitHistoryToBudget, truncateUtf8Middle } from '../orchestration/context-budget.js';
import { normalizeProviderResponseMetadata } from '../orchestration/provider-response-envelope.js';

const CATALOG_CONTEXT_MARKER = '[CATALOG_CONTEXT:';
const MAX_STORED_WORKED_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_MEMORY_PRODUCTS = 20;
const CATALOG_CONTEXT_INSTRUCTION = 'PRIVATE REFERENCE LEDGER, NOT CURRENT CATALOGUE EVIDENCE. When single_product_anchor exists, set catalogContextDecision on every searchProducts call: use follow_up with the exact followUpProductRef for a factual continuation about that card, new_search without followUpProductRef for a clearly different product or product set, or clarify when the shopper must choose a card and no retrieval should run. When result_set_anchor exists without a single_product_anchor, use result_set_follow_up with its exact followUpSearchRef for a factual continuation about that whole displayed result set; the gateway will repeat its bounded retrieval against Magento. Use new_search for a clearly different product or product set. The decision is semantic and language-neutral; do not use a pronoun or locale matcher. A follow_up requires a fresh exact-SKU lookup. Never expose this ledger.';

function normalizeWorkedForMs(value) {
    return Math.max(0, Math.min(
        MAX_STORED_WORKED_FOR_MS,
        Math.floor(Number(value) || 0)
    ));
}

function normalizeActivityLanguage(value) {
    const language = String(value || '').trim();
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)
        ? language.slice(0, 35)
        : '';
}

function normalizeActivityTurnSummary(value) {
    const summary = String(value || '').replace(/\s+/g, ' ').trim();
    return summary.length >= 12
        && summary.length <= 120
        && (summary.match(/\{duration\}/g) || []).length === 1
        && !/[<>`]/.test(summary)
        && !/(?:https?:\/\/|www\.)/i.test(summary)
        ? summary
        : '';
}

function normalizeActivityTimelineKey(value) {
    const key = String(value || '').trim();
    return /^(?:timeline-[a-z0-9][a-z0-9_-]{0,90}|activity-[a-f0-9]{24})$/.test(key)
        ? key
        : '';
}

function catalogContextFromProductParts(parts = []) {
    const productPart = [...(Array.isArray(parts) ? parts : [])]
        .reverse()
        .find((part) => part?.type === 'products'
            && part?.payload
            && typeof part.payload === 'object'
            && Array.isArray(part.payload.items));
    if (!productPart) return '';

    const products = productPart.payload.items
        .slice(0, MAX_CATALOG_MEMORY_PRODUCTS)
        .map((item, index) => catalogMemoryProduct(item, index + 1))
        .filter(Boolean);
    if (products.length === 0) return '';

    const singleProduct = products.length === 1 ? products[0] : null;
    const resultSetAnchor = catalogResultSetAnchor(productPart.payload);
    return `${CATALOG_CONTEXT_MARKER}v2]\n${JSON.stringify({
        instruction: CATALOG_CONTEXT_INSTRUCTION,
        products,
        ...(singleProduct ? {
            single_product_anchor: {
                product_ref: singleProduct.product_ref,
                sku: singleProduct.sku
            }
        } : {}),
        ...(resultSetAnchor ? { result_set_anchor: resultSetAnchor } : {})
    })}`;
}

function catalogResultSetAnchor(payload = {}) {
    const source = payload?.catalog_context;
    if (!source || typeof source !== 'object') return null;

    const searchRef = String(source.search_ref || '').trim();
    const request = source.request && typeof source.request === 'object' ? source.request : {};
    if (!/^search:[a-f0-9]{24}$/.test(searchRef)) return null;

    const query = String(request.query || '').trim().slice(0, 160);
    const categoryId = Math.max(0, Math.trunc(Number(request.category_id) || 0));
    const minPrice = positiveFiniteNumber(request.min_price);
    const maxPrice = positiveFiniteNumber(request.max_price);
    const priceCurrency = String(request.price_currency || '').trim().toUpperCase();
    const requiredVariantAttributeCode = String(request.required_variant_attribute_code || '').trim().toLowerCase();
    const requiredVariantOptionValues = normalizeCatalogOptionValues(request.required_variant_option_values);
    const excludedVariantOptionValues = normalizeCatalogOptionValues(request.excluded_variant_option_values);
    const directAddOnly = request.direct_add_only === true;
    const browseAll = request.browse_all === true;
    if (!query && !categoryId && !minPrice && !maxPrice && !directAddOnly && !browseAll && !requiredVariantAttributeCode) {
        return null;
    }

    return {
        search_ref: searchRef,
        request: {
            query,
            ...(categoryId ? { category_id: categoryId } : {}),
            ...(minPrice ? { min_price: minPrice } : {}),
            ...(maxPrice ? { max_price: maxPrice } : {}),
            ...(minPrice || maxPrice) && /^[A-Z]{3}$/.test(priceCurrency) ? { price_currency: priceCurrency } : {},
            ...(directAddOnly ? { direct_add_only: true } : {}),
            ...(browseAll ? { browse_all: true } : {}),
            ...(requiredVariantAttributeCode && /^[a-z][a-z0-9_]{0,63}$/.test(requiredVariantAttributeCode)
                ? { required_variant_attribute_code: requiredVariantAttributeCode }
                : {}),
            ...(requiredVariantAttributeCode && /^[a-z][a-z0-9_]{0,63}$/.test(requiredVariantAttributeCode)
                && requiredVariantOptionValues.length > 0
                ? { required_variant_option_values: requiredVariantOptionValues }
                : {}),
            ...(requiredVariantAttributeCode && /^[a-z][a-z0-9_]{0,63}$/.test(requiredVariantAttributeCode)
                && excludedVariantOptionValues.length > 0
                ? { excluded_variant_option_values: excludedVariantOptionValues }
                : {})
        }
    };
}

function positiveFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeCatalogOptionValues(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map((item) => String(item || '').trim())
        .filter((item) => item && item.length <= 120)
        .slice(0, 12))];
}

function catalogMemoryProduct(item = {}, position) {
    const productRef = String(item?.product_ref ?? item?.productRef ?? '').trim();
    const sku = String(item?.sku || '').trim();
    if (!/^product:\d{1,12}$/.test(productRef) || !sku || sku.length > 128) return null;

    const name = String(item?.name || '').replace(/\s+/g, ' ').trim().slice(0, 255);
    const url = String(item?.url || '').trim();
    return {
        position,
        product_ref: productRef,
        sku,
        ...(name ? { name } : {}),
        ...(url && /^(?:https?:\/\/|\/)/i.test(url) ? { url: url.slice(0, 2048) } : {})
    };
}

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
        const interrupted = message?.interrupted === true;
        const interruptionReason = String(message?.interruption_reason || '') === 'connection_lost'
            ? 'connection_lost'
            : '';
        const sourceParts = Array.isArray(message?.parts) ? message.parts : [];
        const rawText = sourceParts.length > 0
            ? sourceParts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
            : String(message?.content || message?.text || '');
        const text = rawText.replace(/\n*\[CATALOG_CONTEXT:[\s\S]*$/u, '').trim();
        const imageParts = sourceParts
            .filter((part) => part?.type === 'image' && /^(?:https?:\/\/|\/media\/afd-ai\/generated\/)/i.test(String(part.url || '')))
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

        if (!text && role === 'assistant' && interrupted) {
            return {
                role: 'assistant',
                content: '',
                interrupted: true,
                stopped_after_seconds: Math.max(0, Math.floor(Number(message?.stopped_after_seconds) || 0)),
                ...(interruptionReason ? { interruption_reason: interruptionReason } : {}),
                parts: []
            };
        }

        if (!text && (role === 'user' || (
            imageParts.length === 0
            && guestOrderAccessParts.length === 0
            && addressFormParts.length === 0
        ))) return null;

        if (role === 'user') {
            return { role: 'user', content: text, attachments: [] };
        }

        const workedForMs = normalizeWorkedForMs(message?.workedForMs ?? message?.worked_for_ms);
        return {
            role: 'assistant',
            content: text,
            ...(workedForMs > 0 ? { workedForMs } : {}),
            ...(interrupted ? {
                interrupted: true,
                stopped_after_seconds: Math.max(0, Math.floor(Number(message?.stopped_after_seconds) || 0)),
                ...(interruptionReason ? { interruption_reason: interruptionReason } : {})
            } : {}),
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
        let interruptionReason = String(message?.interruption_reason || '') === 'connection_lost'
            ? 'connection_lost'
            : '';
        let workedForMs = Math.max(
            normalizeWorkedForMs(message?.workedForMs),
            normalizeWorkedForMs(message?.worked_for_ms)
        );

        if (message.role !== 'user' && !Array.isArray(message.parts) && typeof message.content === 'string') {
            try {
                const storedPayload = JSON.parse(message.content);
                if (storedPayload?.format === 'afd_ai_chat_message' && Array.isArray(storedPayload.parts)) {
                    interrupted = storedPayload.interrupted === true;
                    stoppedAfterSeconds = Math.max(
                        0,
                        Math.floor(Number(storedPayload.stopped_after_seconds) || 0)
                    );
                    interruptionReason = String(storedPayload.interruption_reason || '') === 'connection_lost'
                        ? 'connection_lost'
                        : '';
                    workedForMs = Math.max(
                        normalizeWorkedForMs(storedPayload.workedForMs),
                        normalizeWorkedForMs(storedPayload.worked_for_ms)
                    );
                    message = {
                        ...message,
                        // An interrupted request can have no assistant token
                        // yet. Preserve its intentionally blank text rather
                        // than falling back to the serialized JSON payload.
                        content: Object.prototype.hasOwnProperty.call(storedPayload, 'text')
                            ? String(storedPayload.text || '')
                            : message.content,
                        parts: storedPayload.parts,
                        source: storedPayload.source === 'support_agent' ? 'support_agent' : '',
                        sender_label: storedPayload.source === 'support_agent'
                            ? String(storedPayload.sender_label || 'Support team').slice(0, 80)
                            : '',
                        ...(normalizeProviderResponseMetadata(storedPayload.provider_meta)
                            ? { provider_meta: normalizeProviderResponseMetadata(storedPayload.provider_meta) }
                            : {}),
                        interrupted,
                        stopped_after_seconds: stoppedAfterSeconds,
                        interruption_reason: interruptionReason,
                        workedForMs
                    };
                }
            } catch {
                // Legacy assistant rows can contain plain text.
            }
        }

        if (message.role === 'user') return normalizeStoredUserMessage(message);

        const metadata = normalizeStoredMessageMetadata(message);

        if (interrupted && Array.isArray(message.parts) && message.parts.length === 0) {
            return {
                ...metadata,
                role: 'assistant',
                content: '',
                interrupted: true,
                stopped_after_seconds: stoppedAfterSeconds,
                ...(interruptionReason ? { interruption_reason: interruptionReason } : {}),
                workedForMs,
                parts: []
            };
        }

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
                    stopped_after_seconds: stoppedAfterSeconds,
                    ...(interruptionReason ? { interruption_reason: interruptionReason } : {})
                } : {}),
                workedForMs,
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
                stopped_after_seconds: stoppedAfterSeconds,
                ...(interruptionReason ? { interruption_reason: interruptionReason } : {})
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
        const providerMeta = normalizeProviderResponseMetadata(message?.provider_meta);
        if (providerMeta) metadata.provider_meta = providerMeta;
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
        if (!attachment || typeof attachment !== 'object') return null;
        const type = String(attachment.mime_type || attachment.type || 'image/jpeg').toLowerCase();
        const previewUrl = String(
            attachment.previewUrl ||
            attachment.url ||
            (attachment.attachment_id ? `/afd_ai/chat/attachment?id=${encodeURIComponent(attachment.attachment_id)}` : '') ||
            (attachment.data ? `data:${type};base64,${attachment.data}` : '')
        );
        if (!previewUrl) return null;
        return {
            name: attachment.name || 'product-image',
            type,
            size: Number(attachment.size) || (attachment.data ? Math.floor(String(attachment.data).length * 0.75) : 0),
            attachment_id: attachment.attachment_id || null,
            previewUrl
        };
    }

    function normalizeStoredPart(part, message, index) {
        const id = part.id || `${message.entity_id}-${index}`;
        if (part.type === 'products') {
            return { id, type: 'products', html: part.html || '', payload: part.payload || null };
        }
        if (part.type === 'reasoning') {
            const reasoning = normalizeReasoningPart(part);
            return reasoning ? { id, ...reasoning } : { id, type: 'reasoning', events: [], steps: [], activities: [] };
        }
        if (part.type === 'image' && /^(?:https?:\/\/|\/media\/afd-ai\/generated\/)/i.test(String(part.url || ''))) {
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
                const parts = Array.isArray(message.parts) ? message.parts : [];
                const text = parts.length > 0
                    ? parts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
                    : String(message.content || message.text || '');
                const split = splitCatalogContext(text);
                const derivedCatalogContext = split.catalogContext
                    ? ''
                    : catalogContextFromProductParts(parts);
                if (split.catalogContext || derivedCatalogContext) {
                    latestCatalogContext = split.catalogContext || derivedCatalogContext;
                }
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

    /**
     * Extract the only product that can safely be resolved from a previous
     * grid without interpreting shopper prose. The browser creates this
     * anchor only when the latest grid has exactly one item; this function
     * merely validates its bounded identifiers before the tool gateway uses
     * it to force a fresh Magento lookup.
     */
    function latestSingleProductAnchor(history) {
        if (!Array.isArray(history)) return null;

        let catalogContext = '';
        history.forEach((message) => {
            if (!message || !['assistant', 'model'].includes(message.role)) return;
            const parts = Array.isArray(message.parts) ? message.parts : [];
            const text = parts.length > 0
                ? parts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
                : String(message.content || message.text || '');
            const split = splitCatalogContext(text);
            const derivedCatalogContext = split.catalogContext
                ? ''
                : catalogContextFromProductParts(parts);
            if (split.catalogContext || derivedCatalogContext) {
                catalogContext = split.catalogContext || derivedCatalogContext;
            }
        });

        if (!catalogContext) return null;
        const payloadStart = catalogContext.indexOf('\n');
        if (payloadStart < 0) return null;

        try {
            const context = JSON.parse(catalogContext.slice(payloadStart + 1));
            const anchor = context?.single_product_anchor;
            const productRef = String(anchor?.product_ref || '').trim();
            const sku = String(anchor?.sku || '').trim();
            if (!/^product:\d{1,12}$/.test(productRef) || !sku || sku.length > 128) {
                return null;
            }
            return Object.freeze({ productRef, sku });
        } catch {
            return null;
        }
    }

    function latestCatalogResultSetAnchor(history) {
        if (!Array.isArray(history)) return null;

        let catalogContext = '';
        history.forEach((message) => {
            if (!message || !['assistant', 'model'].includes(message.role)) return;
            const parts = Array.isArray(message.parts) ? message.parts : [];
            const text = parts.length > 0
                ? parts.map((part) => part?.text || part?.raw || '').filter(Boolean).join('\n\n')
                : String(message.content || message.text || '');
            const split = splitCatalogContext(text);
            const derivedCatalogContext = split.catalogContext
                ? ''
                : catalogContextFromProductParts(parts);
            if (split.catalogContext || derivedCatalogContext) {
                catalogContext = split.catalogContext || derivedCatalogContext;
            }
        });

        if (!catalogContext) return null;
        const payloadStart = catalogContext.indexOf('\n');
        if (payloadStart < 0) return null;

        try {
            const context = JSON.parse(catalogContext.slice(payloadStart + 1));
            const anchor = context?.result_set_anchor;
            const normalized = catalogResultSetAnchor({ catalog_context: anchor });
            if (!normalized) return null;
            return Object.freeze({
                searchRef: normalized.search_ref,
                request: Object.freeze({ ...normalized.request })
            });
        } catch {
            return null;
        }
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
        const normalizedParts = coalesceProductParts((Array.isArray(parts) ? parts : [])
            .map((part) => normalizeStoragePart(part))
            .filter(Boolean));
        // Keep an empty interrupted assistant row durable. Without it, a page
        // reload before the first streamed token leaves the saved shopper turn
        // with no visible recovery control after history hydration.
        if (normalizedParts.length === 0 && metadata.interrupted !== true) return '';

        const payload = {
            version: 1,
            format: 'afd_ai_chat_message',
            text: extractTextFromParts(normalizedParts),
            parts: normalizedParts
        };
        const workedForMs = normalizeWorkedForMs(metadata.worked_for_ms ?? metadata.workedForMs);
        if (workedForMs > 0) payload.worked_for_ms = workedForMs;
        if (metadata.interrupted === true) {
            payload.interrupted = true;
            payload.stopped_after_seconds = Math.max(
                0,
                Math.floor(Number(metadata.stopped_after_seconds) || 0)
            );
            if (metadata.interruption_reason === 'connection_lost') {
                payload.interruption_reason = 'connection_lost';
            }
        }
        const providerMeta = normalizeProviderResponseMetadata(metadata.provider_meta);
        if (providerMeta) payload.provider_meta = providerMeta;
        return JSON.stringify(payload);
    }

    function normalizeStoragePart(part) {
        if (!part?.type) return null;
        if (part.type === 'products') {
            const html = (part.html || '').trim();
            const payload = part.payload && typeof part.payload === 'object' ? part.payload : null;
            if (!payload && !html) return null;
            // Keep both representations.  The payload is the safe, compact
            // source used for pagination and follow-up questions, while the
            // HTML is the Magento-rendered presentation (including image
            // URLs, price formatting and add-to-cart forms).  Dropping HTML
            // whenever a payload existed made a product result disappear
            // after a history reload in clients that do not re-render it.
            return {
                type: 'products',
                ...(html ? { html } : {}),
                ...(payload ? { payload } : {})
            };
        }
        if (part.type === 'reasoning') return normalizeReasoningPart(part);
        if (part.type === 'image') {
            const url = String(part.url || '').trim();
            if (!/^(?:https?:\/\/|\/media\/afd-ai\/generated\/)/i.test(url)) return null;
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

    /**
     * Retain only explicit tool actions and their generated, customer-safe
     * progress notes. Legacy provider reasoning must never reappear in the
     * history timeline.
     */
    function normalizeReasoningPart(part) {
        const sourceEvents = Array.isArray(part?.events) ? part.events : [
            ...(Array.isArray(part?.steps) ? part.steps : []),
            ...(Array.isArray(part?.activities) ? part.activities : [])
        ];
        const events = [];
        const seen = new Set();

        for (const source of sourceEvents.slice(0, 24)) {
            if (!source || typeof source !== 'object') continue;
            const type = source.type === 'activity' ? 'activity' : (source.type === 'step' ? 'step' : '');
            if (!type) continue;
            const id = String(source.id || `${type}-${events.length}`).slice(0, 120);
            const key = `${type}:${id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (type === 'activity') {
                const tool = String(source.tool || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80);
                if (!tool) continue;
                const resultCount = Number(source.result_count);
                const label = String(source.label || '').replace(/\s+/g, ' ').trim().slice(0, 240);
                const language = normalizeActivityLanguage(source.language);
                const turnSummary = normalizeActivityTurnSummary(source.turn_summary);
                const timelineKey = normalizeActivityTimelineKey(source.timeline_key ?? source.timelineKey);
                events.push({
                    id,
                    type,
                    tool,
                    state: ['running', 'completed', 'failed'].includes(String(source.state || ''))
                        ? String(source.state)
                        : 'completed',
                    ...(Number.isFinite(resultCount) && resultCount >= 0
                        ? { result_count: Math.min(10000, Math.floor(resultCount)) }
                        : {}),
                    ...(label ? { label } : {}),
                    ...(language ? { language } : {}),
                    ...(turnSummary ? { turn_summary: turnSummary } : {}),
                    ...(timelineKey ? { timeline_key: timelineKey } : {})
                });
                continue;
            }

            if (source.source !== 'tool_progress') continue;
            const tool = String(source.tool || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80);
            if (!tool) continue;
            events.push({
                id,
                type,
                source: 'tool_progress',
                tool,
                state: ['running', 'completed', 'failed'].includes(String(source.state || ''))
                    ? String(source.state)
                    : 'completed'
            });
        }

        if (events.length === 0) return null;
        const steps = events.filter(event => event.type === 'step');
        const activities = events.filter(event => event.type === 'activity');
        const elapsedMs = normalizeWorkedForMs(part?.elapsedMs);
        return {
            type: 'reasoning',
            events,
            steps,
            activities,
            ...(elapsedMs > 0 ? { elapsedMs } : {})
        };
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
        trimHistoryForModel,
        latestSingleProductAnchor,
        latestCatalogResultSetAnchor
    };
}
