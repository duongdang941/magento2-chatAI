export function createSupportBroadcaster({ clientData, isSocketOpen }) {
    const send = (socket, payload) => {
        if (!isSocketOpen(socket)) return false;
        socket.send(JSON.stringify(payload));
        return true;
    };

    const matchingCustomer = (client, customerId, guestId) => client?.role !== 'support_admin'
        && (customerId > 0
            ? Number(client?.customerId) === Number(customerId)
            : !client?.customerId && String(client?.guestHistoryId || '') === String(guestId || ''));
    const matchingAdmin = (client, conversationId) => client?.role === 'support_admin'
        && Number(client?.supportConversationId) === Number(conversationId);

    function broadcastSupportMessage({ conversationId, customerId, guestId, messageId }) {
        return broadcast((socket, client) => (
            matchingCustomer(client, customerId, guestId) || matchingAdmin(client, conversationId)
        ) && send(socket, {
            type: 'support_message',
            conversation_id: Number(conversationId),
            message_id: Number(messageId)
        }));
    }

    function broadcastSupportMutation(payload) {
        return broadcast((socket, client) => (
            matchingCustomer(client, payload.customerId, payload.guestId)
            || matchingAdmin(client, payload.conversationId)
        ) && send(socket, {
            type: 'support_message_mutation',
            conversation_id: Number(payload.conversationId),
            message_id: Number(payload.messageId),
            operation: payload.operation,
            content: payload.operation === 'edit' ? String(payload.content || '') : '',
            edited_at: String(payload.editedAt || ''),
            deleted_at: String(payload.deletedAt || '')
        }));
    }

    function broadcastSupportTypingToCustomers({ conversationId, typing, agentLabel }) {
        return broadcast((socket, client) => client?.role !== 'support_admin'
            && Number(client?.activeSupportConversationId) === Number(conversationId)
            && send(socket, {
                type: 'support_typing',
                conversation_id: Number(conversationId),
                actor: 'admin',
                typing: typing === true,
                label: typing === true ? String(agentLabel || 'Support team').slice(0, 80) : ''
            }));
    }

    function broadcastSupportTypingToAdmins({ conversationId, typing }) {
        return broadcast((socket, client) => matchingAdmin(client, conversationId) && send(socket, {
            type: 'support_typing',
            conversation_id: Number(conversationId),
            actor: 'customer',
            typing: typing === true
        }));
    }

    function broadcastSupportMessageToAdmins({ conversationId, messageId }) {
        return broadcast((socket, client) => matchingAdmin(client, conversationId) && send(socket, {
            type: 'support_message',
            conversation_id: Number(conversationId),
            message_id: Number(messageId)
        }));
    }

    function broadcastSupportMode({ conversationId, customerId, guestId, active, agentLabel }) {
        return broadcast((socket, client) => matchingCustomer(client, customerId, guestId) && send(socket, {
            type: 'support_mode',
            conversation_id: Number(conversationId),
            active: active === true,
            agent_label: active === true ? String(agentLabel || '').slice(0, 80) : ''
        }));
    }

    function broadcast(visitor) {
        let recipients = 0;
        for (const [socket, client] of clientData.entries()) {
            if (visitor(socket, client)) recipients += 1;
        }
        return recipients;
    }

    return Object.freeze({
        broadcastSupportMessage,
        broadcastSupportMutation,
        broadcastSupportTypingToCustomers,
        broadcastSupportTypingToAdmins,
        broadcastSupportMessageToAdmins,
        broadcastSupportMode
    });
}
