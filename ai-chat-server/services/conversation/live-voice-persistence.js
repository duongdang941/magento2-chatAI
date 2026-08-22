/**
 * Persist only the text transcript of a completed Live Voice turn. Audio is
 * handled directly by the browser/WebRTC session and is intentionally absent
 * from this transport and from Magento storage.
 */
function readText(value, maximum = 8000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function positiveId(value) {
    const id = Math.trunc(Number(value) || 0);
    return id > 0 ? id : 0;
}

function guestHistoryIdentity(client) {
    return String(client?.guestHistoryId || '');
}

function storagePayload(text) {
    return JSON.stringify({
        version: 1,
        format: 'afd_ai_chat_message',
        text,
        parts: [{ type: 'text', raw: text }]
    });
}

async function resolveCustomerConversation({ db, client, requestedId, title, catalogScope }) {
    if (requestedId) {
        const owned = await db.getConversation(requestedId, client.customerId, catalogScope);
        if (owned) return requestedId;
    }
    return Number(await db.createConversation(client.customerId, title, catalogScope)) || 0;
}

async function resolveGuestConversation({ db, guestSessionHistory, client, requestedId, guestMode, title, catalogScope }) {
    if (requestedId) {
        const owned = guestMode === 'database'
            ? await db.getGuestConversation(requestedId, guestHistoryIdentity(client), catalogScope)
            : await guestSessionHistory.get(guestHistoryIdentity(client), requestedId);
        if (owned) return requestedId;
    }
    if (guestMode === 'database') {
        const page = await db.listGuestConversations(guestHistoryIdentity(client), 1, catalogScope);
        const existing = Array.isArray(page?.conversations) ? page.conversations[0] : null;
        return positiveId(existing?.id) || positiveId(await db.createGuestConversation(guestHistoryIdentity(client), title, catalogScope));
    }
        const conversation = await guestSessionHistory.create(guestHistoryIdentity(client), title);
    return positiveId(conversation?.id || conversation);
}

function turnTitle(userText) {
    const normalized = readText(userText, 255);
    return normalized || 'Voice conversation';
}

/**
 * Keep the normal text history as the source of truth after a voice session.
 * This uses the same durable stores as text chat and works for temporary or
 * database-backed guest history without serialising sound recordings.
 */
export async function persistLiveVoiceTurn({
    ws,
    data,
    client,
    runtime,
    getConfig,
    db,
    guestSessionHistory,
    attachRequestId,
    broadcastGuestConversation = async () => {}
}) {
    const requestId = String(data?.request_id || '').slice(0, 120);
    const turnId = String(data?.turn_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
    const send = (payload) => ws.send(attachRequestId({ ...payload, request_id: requestId }, requestId));
    const userText = readText(data?.user_text);
    const assistantText = readText(data?.assistant_text);
    if (!turnId || !userText || !assistantText) {
        send({ type: 'live_voice_save_error', turn_id: turnId, content: 'The completed voice turn could not be saved.' });
        return;
    }

    const identity = String(client?.rateLimitKey || client?.sessionId || 'unknown');
    const duplicate = await runtime.claimOnce(`live-voice-turn:${identity}`, turnId, 10 * 60 * 1000);
    if (!duplicate) return;

    const config = await getConfig(runtime, client?.catalogScope?.storeCode || '');
    const catalogScope = client?.catalogScope || null;
    const requestedId = positiveId(data?.conversation_id);
    try {
        let conversationId;
        let userMessageId;
        let assistantMessageId;
        if (client?.customerId) {
            conversationId = await resolveCustomerConversation({
                db,
                client,
                requestedId,
                title: turnTitle(userText),
                catalogScope
            });
            userMessageId = await db.saveMessage(conversationId, client.customerId, 'user', userText, null, catalogScope);
            assistantMessageId = await db.saveMessage(conversationId, client.customerId, 'assistant', storagePayload(assistantText), null, catalogScope);
            await db.touchConversation(conversationId, client.customerId, catalogScope);
        } else {
            const guestMode = config.persist_guest_history === true ? 'database' : 'session';
            conversationId = await resolveGuestConversation({
                db,
                guestSessionHistory,
                client,
                requestedId,
                guestMode,
                title: turnTitle(userText),
                catalogScope
            });
            if (guestMode === 'database') {
                userMessageId = await db.saveGuestMessage(conversationId, guestHistoryIdentity(client), 'user', userText, null, catalogScope);
                assistantMessageId = await db.saveGuestMessage(conversationId, guestHistoryIdentity(client), 'assistant', storagePayload(assistantText), null, catalogScope);
                await db.touchGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope);
            } else {
                userMessageId = await guestSessionHistory.append(guestHistoryIdentity(client), conversationId, { role: 'user', content: userText, attachments: [] });
                assistantMessageId = await guestSessionHistory.append(guestHistoryIdentity(client), conversationId, {
                    role: 'assistant',
                    content: assistantText,
                    parts: [{ type: 'text', raw: assistantText }]
                });
            }
            await broadcastGuestConversation(ws, client, guestMode, conversationId);
        }
        send({
            type: 'live_voice_saved',
            turn_id: turnId,
            conversation_id: conversationId,
            user_message_id: positiveId(userMessageId),
            assistant_message_id: positiveId(assistantMessageId)
        });
        ws.send(JSON.stringify({ type: 'refresh_conversations' }));
    } catch {
        send({
            type: 'live_voice_save_error',
            turn_id: turnId,
            content: 'The voice transcript could not be saved, but the audio was not retained.'
        });
    }
}
