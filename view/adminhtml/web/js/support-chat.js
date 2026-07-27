define(['Afd_AI/js/support-realtime'], function (createSupportRealtime) {
    'use strict';

    return function (config, root) {
        const messages = root.querySelector('[data-role="messages"]');
        const composer = root.querySelector('[data-role="composer"]');
        const input = composer?.querySelector('textarea') || null;
        const sendButton = composer?.querySelector('.afd-ai-chat__send-btn') || null;
        const closedNotice = root.querySelector('[data-role="closed"]');
        const notice = root.querySelector('[data-role="notice"]');
        const formKey = String(root.querySelector('input[name="form_key"]')?.value || '');
        let currentCaseId = Number(config.caseId) || 0;
        let currentConversationId = Number(config.conversationId) || 0;
        let lastMessageId = Number(config.lastMessageId) || 0;
        let requestVersion = 0;
        let polling = false;
        let typingIdleTimer = null;
        let remoteTypingTimer = null;
        let realtime = null;

        const syncSendButton = () => {
            if (!sendButton || !input) return;
            sendButton.disabled = composer.hidden
                || composer.classList.contains('is-sending')
                || !input.value.trim();
        };

        const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
        const scrollBottom = (force) => {
            if (force || nearBottom()) messages.scrollTop = messages.scrollHeight;
        };

        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'afd-ai-chat__msg-ai afd-ai-support-typing';
        typingIndicator.hidden = true;
        typingIndicator.innerHTML = '<div class="afd-ai-chat__msg-content"><div class="afd-ai-chat__msg-assistant-stack"><div class="afd-ai-chat__typing-bubble" aria-label="Customer is typing"><span></span><span></span><span></span></div></div></div>';

        const setRemoteTyping = (typing) => {
            if (remoteTypingTimer) window.clearTimeout(remoteTypingTimer);
            if (typing) {
                if (!typingIndicator.isConnected) messages.appendChild(typingIndicator);
                typingIndicator.hidden = false;
                scrollBottom(false);
                remoteTypingTimer = window.setTimeout(() => setRemoteTyping(false), 2600);
            } else {
                typingIndicator.hidden = true;
            }
        };

        const syncLocalTyping = (forceHeartbeat = false) => {
            if (typingIdleTimer) window.clearTimeout(typingIdleTimer);
            const typing = !document.hidden && Boolean(input?.value.trim()) && !composer?.hidden;
            realtime?.setTyping(typing, forceHeartbeat && typing);
            if (typing) typingIdleTimer = window.setTimeout(() => syncLocalTyping(true), 900);
        };
        const appendMessage = (message, forceScroll) => {
            if (!message.entity_id || messages.querySelector('[data-message-id="' + message.entity_id + '"]')) return;
            const shouldScroll = forceScroll || nearBottom();
            const row = document.createElement('div');
            row.dataset.messageId = String(message.entity_id);
            const content = document.createElement('div');
            const stack = document.createElement('div');
            const bubble = document.createElement('div');
            const isAgent = message.source === 'support_agent';
            const isCustomer = message.role === 'user';

            if (isAgent) {
                row.className = 'afd-ai-chat__msg-user';
                content.className = 'afd-ai-chat__msg-user-content';
                stack.className = 'afd-ai-chat__msg-user-stack';
                bubble.className = 'afd-ai-chat__msg-bubble-user';
                const text = document.createElement('div');
                text.className = 'afd-ai-chat__msg-user-text';
                text.textContent = String(message.text || '');
                bubble.appendChild(text);
            } else {
                row.className = 'afd-ai-chat__msg-ai';
                content.className = 'afd-ai-chat__msg-content';
                stack.className = 'afd-ai-chat__msg-assistant-stack';
                bubble.className = isCustomer
                    ? 'afd-ai-chat__msg-bubble-customer'
                    : 'afd-ai-chat__msg-bubble-ai';
                const text = document.createElement('div');
                text.className = 'afd-ai-chat__msg-part';
                text.textContent = String(message.text || '');
                bubble.appendChild(text);
            }
            stack.appendChild(bubble);
            content.appendChild(stack);
            row.appendChild(content);
            messages.insertBefore(row, typingIndicator.isConnected ? typingIndicator : null);
            lastMessageId = Math.max(lastMessageId, Number(message.entity_id) || 0);
            if (shouldScroll) scrollBottom(true);
        };

        const updateCaseHeader = (supportCase) => {
            if (!supportCase) return;
            const values = {
                'case-subject': supportCase.subject,
                'case-public-id': supportCase.public_id,
                'case-status': supportCase.status,
                'case-priority': supportCase.priority,
                'case-category': supportCase.category,
                'case-summary': supportCase.summary
            };
            Object.entries(values).forEach(([role, value]) => {
                const target = root.querySelector('[data-role="' + role + '"]');
                if (target) target.textContent = String(value || '');
            });
            if (composer) composer.hidden = supportCase.can_reply !== true;
            if (closedNotice) closedNotice.hidden = supportCase.can_reply === true;
            syncSendButton();
            if (composer?.hidden) realtime?.setTyping(false, true);
        };

        const markRead = async (caseId) => {
            const body = new FormData();
            body.set('entity_id', String(caseId));
            body.set('form_key', formKey);
            try {
                await fetch(config.markReadUrl, {
                    method: 'POST', body, credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                const ticket = root.querySelector('[data-role="ticket"][data-case-id="' + caseId + '"]');
                ticket?.closest('[data-role="ticket-wrap"]')?.classList.remove('is-unread');
                ticket?.querySelector('[data-role="unread-count"]')?.remove();
            } catch (error) {
                // Read state is retried on the next selection or page load.
            }
        };

        const loadMessages = async ({ replace = false, forceScroll = false } = {}) => {
            if (polling && !replace) return;
            const version = replace ? ++requestVersion : requestVersion;
            polling = true;
            try {
                const url = new URL(config.messagesUrl, window.location.origin);
                url.searchParams.set('entity_id', String(currentCaseId));
                url.searchParams.set('after_id', replace ? '0' : String(lastMessageId));
                const response = await fetch(url.toString(), {
                    credentials: 'same-origin', headers: { Accept: 'application/json' }
                });
                const payload = await response.json();
                if (!response.ok || payload.status !== 'success' || version !== requestVersion) return;
                if (replace) {
                    messages.replaceChildren();
                    lastMessageId = 0;
                    updateCaseHeader(payload.case);
                }
                (payload.messages || []).forEach((message) => appendMessage(message, forceScroll || replace));
            } catch (error) {
                // Polling resumes automatically.
            } finally {
                polling = false;
            }
        };

        root.querySelectorAll('[data-role="ticket"]').forEach((ticket) => {
            ticket.addEventListener('click', async () => {
                const nextCaseId = Number(ticket.dataset.caseId) || 0;
                if (!nextCaseId || nextCaseId === currentCaseId) {
                    await markRead(currentCaseId);
                    return;
                }
                currentCaseId = nextCaseId;
                currentConversationId = Number(ticket.dataset.conversationId) || 0;
                lastMessageId = 0;
                setRemoteTyping(false);
                realtime?.setTyping(false, true);
                realtime?.subscribe(currentConversationId);
                root.querySelectorAll('[data-role="ticket"]').forEach((item) => {
                    const active = item === ticket;
                    item.classList.toggle('afd-ai-chat__sidebar-item--active', active);
                    item.closest('[data-role="ticket-wrap"]')?.classList.toggle('afd-ai-chat__sidebar-item-wrap--active', active);
                    item.setAttribute('aria-pressed', active ? 'true' : 'false');
                });
                root.classList.remove('is-sidebar-open');
                if (composer) composer.querySelector('input[name="entity_id"]').value = String(currentCaseId);
                messages.classList.add('is-loading');
                await loadMessages({ replace: true, forceScroll: true });
                messages.classList.remove('is-loading');
                await markRead(currentCaseId);
            });
        });

        if (composer) {
            const submitReply = async () => {
                const reply = input.value.trim();
                if (!reply || composer.classList.contains('is-sending')) {
                    syncSendButton();
                    return;
                }
                const body = new FormData(composer);
                body.set('reply', reply);
                const pendingId = 'pending-' + Date.now();
                input.value = '';
                input.style.height = '';
                composer.classList.remove('afd-ai-chat__composer-shell--expanded');
                composer.classList.add('is-sending');
                realtime?.setTyping(false, true);
                appendMessage({ entity_id: pendingId, role: 'assistant', source: 'support_agent', text: reply }, true);
                syncSendButton();
                try {
                    const response = await fetch(config.replyUrl, {
                        method: 'POST', body, credentials: 'same-origin',
                        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                    });
                    const payload = await response.json();
                    if (!response.ok || payload.status !== 'success') throw new Error(payload.message || 'Message could not be sent.');
                    messages.querySelector('[data-message-id="' + pendingId + '"]')?.remove();
                    await loadMessages({ forceScroll: true });
                } catch (error) {
                    messages.querySelector('[data-message-id="' + pendingId + '"]')?.remove();
                    if (!input.value.trim()) input.value = reply;
                    if (notice) {
                        notice.textContent = error.message || 'Message could not be sent.';
                        notice.hidden = false;
                    }
                } finally {
                    composer.classList.remove('is-sending');
                    syncSendButton();
                    input.focus();
                }
            };
            composer.addEventListener('submit', (event) => {
                event.preventDefault();
                submitReply();
            });
            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                event.stopPropagation();
                submitReply();
            }, true);
            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 144) + 'px';
                if (!input.value.trim()) {
                    composer.classList.remove('afd-ai-chat__composer-shell--expanded');
                } else if (input.scrollHeight > 44) {
                    composer.classList.add('afd-ai-chat__composer-shell--expanded');
                }
                syncSendButton();
                syncLocalTyping();
            });
            syncSendButton();
        }

        realtime = createSupportRealtime({
            ticketUrl: config.socketTicketUrl,
            onTyping: setRemoteTyping,
            onMessage: () => {
                setRemoteTyping(false);
                if (!document.hidden) loadMessages({ forceScroll: true });
            }
        });
        realtime.subscribe(currentConversationId);

        root.querySelector('[data-role="sidebar-toggle"]')?.addEventListener('click', () => {
            root.classList.toggle('is-sidebar-open');
        });

        scrollBottom(true);
        markRead(currentCaseId);
        window.setInterval(() => { if (!document.hidden) loadMessages(); }, 2500);
        window.addEventListener('beforeunload', () => realtime?.destroy(), { once: true });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                loadMessages();
                markRead(currentCaseId);
                syncLocalTyping();
            } else {
                realtime?.setTyping(false, true);
            }
        });
    };
});
