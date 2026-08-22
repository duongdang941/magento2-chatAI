define([], function () {
    'use strict';

    const socketUrl = (value) => {
        const fallback = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ai-gateway/`;
        const url = new URL(String(value || fallback), fallback);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        return url;
    };

    return function createSupportRealtime(options) {
        let socket = null;
        let currentConversationId = 0;
        let reconnectTimer = null;
        let stopped = false;
        let lastTypingState = false;
        let lastTypingSentAt = 0;

        const send = (payload) => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return false;
            socket.send(JSON.stringify(payload));
            return true;
        };

        const subscribe = (conversationId) => {
            currentConversationId = Math.max(0, Number(conversationId) || 0);
            lastTypingState = false;
            lastTypingSentAt = 0;
            send({ action: 'support_subscribe', conversation_id: currentConversationId });
            options.onTyping?.(false);
        };

        const connect = async () => {
            if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
            try {
                const response = await fetch(options.ticketUrl, {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                });
                const payload = await response.json();
                if (!response.ok || payload.status !== 'success') throw new Error('Ticket unavailable');
                const url = socketUrl(payload.websocket_url);
                url.searchParams.set('ticket', payload.websocket_ticket);
                socket = new WebSocket(url.toString());
                socket.addEventListener('open', () => {
                    if (currentConversationId) subscribe(currentConversationId);
                    options.onConnection?.(true);
                });
                socket.addEventListener('message', (event) => {
                    let data;
                    try { data = JSON.parse(event.data); } catch (error) { return; }
                    if (Number(data.conversation_id) !== currentConversationId) return;
                    if (data.type === 'support_typing' && data.actor === 'customer') {
                        options.onTyping?.(data.typing === true);
                    } else if (data.type === 'support_message') {
                        options.onMessage?.(data);
                    } else if (data.type === 'support_message_mutation') {
                        options.onMutation?.(data);
                    }
                });
                socket.addEventListener('close', () => {
                    socket = null;
                    options.onTyping?.(false);
                    options.onConnection?.(false);
                    if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
                });
                socket.addEventListener('error', () => options.onConnection?.(false));
            } catch (error) {
                options.onConnection?.(false);
                if (!stopped) reconnectTimer = window.setTimeout(connect, 2000);
            }
        };

        const setTyping = (typing, force = false) => {
            const next = typing === true && currentConversationId > 0;
            const now = Date.now();
            if (!force && next === lastTypingState && (!next || now - lastTypingSentAt < 900)) return;
            if (send({
                action: 'support_typing',
                conversation_id: currentConversationId,
                typing: next
            })) {
                lastTypingState = next;
                lastTypingSentAt = now;
            }
        };

        connect();

        return {
            subscribe,
            setTyping,
            destroy() {
                stopped = true;
                if (reconnectTimer) window.clearTimeout(reconnectTimer);
                setTyping(false, true);
                socket?.close();
                socket = null;
            }
        };
    };
});
