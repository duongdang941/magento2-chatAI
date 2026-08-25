/**
 * WebSocket connection lifecycle cleanup.
 *
 * This module owns only close/error teardown. Message routing remains in the
 * gateway so lifecycle side effects are explicit and independently testable.
 */
export function createConnectionLifecycle({
    clientData,
    wss,
    metrics,
    cancelActiveRun,
    browserCartBridge,
    broadcastSupportTypingToCustomers,
    broadcastSupportTypingToAdmins,
    logger = console
}) {
    function clearSupportTyping(client) {
        if (client && client.role === 'support_admin' && client.supportConversationId) {
            broadcastSupportTypingToCustomers({
                conversationId: client.supportConversationId,
                typing: false,
                agentLabel: client.adminName
            });
        } else if (client && client.activeSupportConversationId) {
            broadcastSupportTypingToAdmins({
                conversationId: client.activeSupportConversationId,
                typing: false
            });
        }
    }

    function cleanup(ws, metricName) {
        const client = clientData.get(ws);
        clearSupportTyping(client);
        // A page reload closes the socket while the gateway can still be
        // waiting for the provider's first token. Mark it for durable recovery
        // instead of treating it as a deliberate shopper stop.
        cancelActiveRun(ws, null, 'connection_lost');
        browserCartBridge.rejectAll(ws);
        clientData.delete(ws);
        metrics.increment(metricName);
        return client;
    }

    function handleClose(ws) {
        cleanup(ws, 'websocket_disconnected');
        logger.log(`Client disconnected [total=${wss.clients.size}]`);
    }

    function handleError(ws, error) {
        logger.error('WebSocket error:', error.message);
        cleanup(ws, 'websocket_error');
    }

    return { clearSupportTyping, cleanup, handleClose, handleError };
}
