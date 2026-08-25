import { guestHistoryIdentity } from './guest-history.js';
import { normalizeProviderResponseMetadata } from '../orchestration/provider-response-envelope.js';

/** Keeps durable/session guest history and cross-tab views on one path. */
export function createGuestHistorySync({
    wss,
    clientData,
    isSocketOpen,
    guestSessionHistory,
    loadGuestMessages,
    getPrepareHistoryMessages,
    extractTextFromParts,
    guestHistoryMessagesFromClient,
    summarizeError
}) {
    function guestUserHistoryMessage(currentUser, data) {
        const uploadedImages = Array.isArray(data.images) ? data.images : [];
        const sourceParts = Array.isArray(currentUser.parts) ? currentUser.parts : [];
        const attachmentRefParts = sourceParts.filter(
            part => part && (part.type === 'attachment_ref' || part.attachment_id)
        );
        const imageParts = sourceParts.filter(part => part?.inline_data);

        let attachments = [];
        if (attachmentRefParts.length > 0) {
            attachments = attachmentRefParts.map((ref, index) => ({
                name: String(uploadedImages[index]?.name || ref.name || 'image').slice(0, 120),
                mime_type: ref.mime_type || uploadedImages[index]?.type || 'image/jpeg',
                size: Number(uploadedImages[index]?.size || ref.size || 0),
                attachment_id: ref.attachment_id,
                url: `/afd_ai/chat/attachment?id=${encodeURIComponent(ref.attachment_id)}`,
                previewUrl: `/afd_ai/chat/attachment?id=${encodeURIComponent(ref.attachment_id)}`
            }));
        } else if (imageParts.length > 0) {
            attachments = imageParts.map((part, index) => ({
                name: String(uploadedImages[index]?.name || data.image?.name || 'uploaded-image').slice(0, 120),
                mime_type: part.inline_data.mime_type,
                data: part.inline_data.data,
                url: `data:${part.inline_data.mime_type || 'image/jpeg'};base64,${part.inline_data.data}`,
                previewUrl: `data:${part.inline_data.mime_type || 'image/jpeg'};base64,${part.inline_data.data}`
            }));
        }

        return {
            role: 'user',
            content: currentUser.displayText || currentUser.text || '',
            attachments
        };
    }

    function buildUserMessageAttachmentPayload(currentUser, data) {
        const uploadedImages = Array.isArray(data.images) ? data.images : [];
        const sourceParts = Array.isArray(currentUser.parts) ? currentUser.parts : [];
        const attachmentRefParts = sourceParts.filter(
            part => part && (part.type === 'attachment_ref' || part.attachment_id)
        );
        const imageParts = sourceParts.filter(part => part?.inline_data).map(part => part.inline_data);

        if (attachmentRefParts.length > 0) {
            return JSON.stringify({
                attachments: attachmentRefParts.map((ref, index) => ({
                    name: String(uploadedImages[index]?.name || ref.name || 'image').slice(0, 120),
                    mime_type: ref.mime_type || uploadedImages[index]?.type || 'image/jpeg',
                    size: Number(uploadedImages[index]?.size || ref.size || 0),
                    attachment_id: ref.attachment_id,
                    url: `/afd_ai/chat/attachment?id=${encodeURIComponent(ref.attachment_id)}`
                }))
            });
        }

        if (imageParts.length > 0) {
            return JSON.stringify({
                attachments: imageParts.map((imagePart, index) => ({
                    name: String(uploadedImages[index]?.name || data.image?.name || 'uploaded-image').slice(0, 120),
                    mime_type: imagePart.mime_type,
                    data: imagePart.data,
                    url: `data:${imagePart.mime_type || 'image/jpeg'};base64,${imagePart.data}`
                }))
            });
        }

        return null;
    }

    function guestAssistantHistoryMessage(parts, metadata = {}) {
        const providerMetadata = normalizeProviderResponseMetadata(metadata.provider_meta);
        const workedForMs = Math.max(0, Math.min(
            24 * 60 * 60 * 1000,
            Math.floor(Number(metadata.worked_for_ms ?? metadata.workedForMs) || 0)
        ));
        return {
            role: 'assistant',
            content: extractTextFromParts(parts),
            parts,
            ...(workedForMs > 0 ? { workedForMs } : {}),
            ...(providerMetadata ? { provider_meta: providerMetadata } : {}),
            ...(metadata.interrupted === true ? {
                interrupted: true,
                stopped_after_seconds: Math.max(0, Math.floor(Number(metadata.stopped_after_seconds) || 0)),
                ...(metadata.interruption_reason === 'connection_lost'
                    ? { interruption_reason: 'connection_lost' }
                    : {})
            } : {})
        };
    }

    async function restoreGuestHistoryFromClient(history, guestId, conversationId) {
        for (const message of guestHistoryMessagesFromClient(history)) {
            await guestSessionHistory.append(guestId, conversationId, message);
        }
    }

    function broadcastGuestSession(origin, client, payload) {
        const guestId = guestHistoryIdentity(client);
        if (!guestId) return;
        for (const socket of wss.clients) {
            if (socket === origin || !isSocketOpen(socket)) continue;
            const candidate = clientData.get(socket);
            if (!candidate || candidate.customerId || guestHistoryIdentity(candidate) !== guestId) continue;
            socket.send(JSON.stringify(payload));
        }
    }

    async function broadcastGuestConversation(origin, client, mode, conversationId) {
        try {
            const page = mode === 'database'
                ? await loadGuestMessages(
                    conversationId,
                    guestHistoryIdentity(client),
                    null,
                    client.catalogScope || null
                )
                : await guestSessionHistory.loadMessages(guestHistoryIdentity(client), conversationId);
            const messages = await getPrepareHistoryMessages()(page.messages || [], client, conversationId);
            broadcastGuestSession(origin, client, {
                type: 'guest_history_sync',
                conversation_id: conversationId,
                messages
            });
        } catch (error) {
            console.warn('[Chat] Guest cross-tab history sync failed:', summarizeError(error));
        }
    }

    return {
        broadcastGuestConversation,
        broadcastGuestSession,
        buildUserMessageAttachmentPayload,
        guestAssistantHistoryMessage,
        guestUserHistoryMessage,
        restoreGuestHistoryFromClient
    };
}
