/** Close only sockets that belong to a Magento logout event. */
export function revokeCustomerSockets({
    clientData,
    sessionHash,
    customerId = 0,
    isSocketOpen,
    cancelActiveRun,
    rejectBrowserCart
}) {
    let closed = 0;
    for (const [socket, client] of clientData.entries()) {
        const sessionMatches = String(client?.sessionId || '') === String(sessionHash || '');
        const customerMatches = Number(customerId) > 0 && Number(client?.customerId) === Number(customerId);
        if (!sessionMatches && !customerMatches) continue;

        cancelActiveRun(socket);
        rejectBrowserCart(socket);
        if (isSocketOpen(socket)) {
            socket.send(JSON.stringify({
                type: 'auth_revoked',
                content: 'Your account session changed. Reconnect to continue chatting.'
            }));
            socket.close(4001, 'Customer session revoked');
        }
        clientData.delete(socket);
        closed += 1;
    }
    return closed;
}
