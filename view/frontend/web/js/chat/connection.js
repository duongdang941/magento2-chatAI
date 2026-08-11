/** connectionMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.connectionMethods = function (context) {
const { config, urls } = context;
const {
    sanitizeHtml,
    sanitizeCustomerResponseText,
    hydrateProductGridHtml,
    getBrowserFormKey,
    resolveWebSocketUrl,
    PET_SPRITESHEET_COLUMNS,
    PET_SPRITESHEET_ROWS,
    PET_FRAME_LIBRARY,
    petFramePosition,
    IMAGE_UPLOAD_MAX_BYTES,
    IMAGE_UPLOAD_MAX_COUNT,
    IMAGE_UPLOAD_TYPES,
    MAX_MODEL_HISTORY_MESSAGES
} = context.helpers;

        return {
            initChat() {
                this.restoreUiSettings();
                this.applyUiSettings();
                this.restoreLauncherPosition();
                this.restoreChatWindowLayout();
                this.imageGenerationTimer = window.setInterval(() => {
                    if (this.isLoading) this.imageGenerationNow = Date.now();
                }, 1000);
                window.addEventListener('resize', () => {
                    this.clampLauncherPosition();
                    this.clampChatWindowLayout();
                    this.syncCompactSidebarState();
                });
                if (typeof window.matchMedia === 'function') {
                    const media = window.matchMedia('(prefers-color-scheme: dark)');
                    const onSchemeChange = () => this.applyUiSettings();
                    if (typeof media.addEventListener === 'function') {
                        media.addEventListener('change', onSchemeChange);
                    }
                }

                this.$watch('isOpen', value => {
                    if (value) {
                        this.ensureWebSocketConnection();
                        this.$nextTick(() => this.syncSupportTyping());
                    } else {
                        this.stopSupportTyping();
                    }
                    this.syncPetAnimation();
                });
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) this.stopSupportTyping();
                    else if (this.isOpen) this.syncSupportTyping();
                });
                this.$watch('isLoading', () => this.syncPetAnimation());
                this.$watch('isHistoryLoading', isLoading => {
                    if (!isLoading) this.clearHistoryLoadingTimeout();
                });
                this.$watch('statusMessage', () => this.syncPetAnimation());
                this.$watch('showBubble', () => this.syncPetAnimation());
                this.$watch('hasStartedChat', () => this.syncPetAnimation());
                this.$watch('petHovering', () => this.syncPetAnimation());
                this.$watch('isDragging', () => this.syncPetAnimation());
                this.$watch('petDragState', () => this.syncPetAnimation());
                this.$nextTick(() => {
                    this.observeChatWindowWidth();
                    this.applyUiSettings();
                    this.resizeComposerInput();
                    this.syncPetAnimation();
                });
            },

            async fetchWebSocketTicket() {
                const response = await fetch(urls.session, {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                });
                if (!response.ok) throw new Error('Could not create a secure chat connection.');
                const payload = await response.json();
                if (payload.status !== 'success' || !payload.websocketTicket) {
                    throw new Error(payload.message || 'Could not create a secure chat connection.');
                }
                return payload.websocketTicket;
            },

            armHistoryLoadingTimeout() {
                this.clearHistoryLoadingTimeout();
                if (!this.isHistoryLoading) return;

                this.historyLoadingTimeout = window.setTimeout(() => {
                    this.historyLoadingTimeout = null;
                    if (!this.isHistoryLoading) return;

                    this.isHistoryLoading = false;
                    if (!this.wsConnected) {
                        this.setTransportNotice(
                            'history-load-timeout',
                            'Chat history is taking longer than expected',
                            'The previous conversation could not be loaded yet. You can still start a new chat.'
                        );
                        this.loadConversationsHTTP();
                    }
                }, 8000);
            },

            clearHistoryLoadingTimeout() {
                if (!this.historyLoadingTimeout) return;
                window.clearTimeout(this.historyLoadingTimeout);
                this.historyLoadingTimeout = null;
            },

            async connectWebSocket() {
                if (this.socketConnectPromise) return this.socketConnectPromise;
                this.wsConnected = false; // Reset before attempt
                this.socketConnectPromise = (async () => {
                    try {
                        const ticket = await this.fetchWebSocketTicket();
                        const socketUrl = new URL(resolveWebSocketUrl(config.chatServerUrl));
                        socketUrl.searchParams.set('ticket', ticket);
                        this.socket = new WebSocket(socketUrl.toString());
                        this.socket.onopen = () => {
                            this.wsConnected = true;
                            this.wsHasEverConnected = true;
                            this.scheduleTicketRefresh();
                        };
                        this.socket.onmessage = (event) => { try { this.handleWsMessage(JSON.parse(event.data)); } catch(e) {} };
                        this.socket.onclose = () => {
                            this.wsConnected = false;
                            this.clearTicketRefresh();
                            this.handleActiveRequestDisconnect();
                            if (this.isOpen && this.wsHasEverConnected) {
                                this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 3000);
                            }
                        };
                        this.socket.onerror = () => {
                            this.wsConnected = false;
                        };
                    } catch(e) {
                        this.wsConnected = false;
                        this.setTransportNotice('socket-auth-failed', 'Secure chat connection unavailable', 'Please refresh the page and try again.');
                        this.loadConversationsHTTP();
                    } finally {
                        this.socketConnectPromise = null;
                    }
                })();
                return this.socketConnectPromise;
            },

            ensureWebSocketConnection() {
                if (this.wsReconnectTimer) {
                    window.clearTimeout(this.wsReconnectTimer);
                    this.wsReconnectTimer = null;
                }

                if (this.socket) {
                    const state = this.socket.readyState;
                    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
                        return;
                    }
                }

                this.connectionAttempted = true;
                this.connectWebSocket();
            },

            scheduleTicketRefresh() {
                this.clearTicketRefresh();
                // Magento tickets are valid for one minute. Reconnect before
                // expiry when idle. Closing an active socket cancels the
                // model run, so defer rotation until that response settles.
                this.ticketRefreshTimer = window.setTimeout(() => {
                    this.ticketRefreshTimer = null;
                    if (this.isLoading) {
                        this.ticketRefreshDeferred = true;
                        return;
                    }
                    this.refreshWebSocketTicket();
                }, 45000);
            },

            refreshWebSocketTicket() {
                this.ticketRefreshDeferred = false;
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.close(4000, 'Refreshing chat authentication');
                }
            },

            refreshDeferredWebSocketTicket() {
                if (!this.ticketRefreshDeferred) return;
                this.refreshWebSocketTicket();
            },

            clearTicketRefresh() {
                if (this.ticketRefreshTimer) {
                    window.clearTimeout(this.ticketRefreshTimer);
                    this.ticketRefreshTimer = null;
                }
            },

            handleComposerInput() {
                this.resizeComposerInput();
                this.syncSupportTyping();
            },

            syncSupportTyping(forceHeartbeat = false) {
                if (this.supportTypingIdleTimer) window.clearTimeout(this.supportTypingIdleTimer);
                const inputValue = String(this.$refs.composerInput?.value ?? this.userInput ?? '').trim();
                const typing = this.humanSupportActive
                    && !this.supportConversationClosed
                    && this.isOpen
                    && !document.hidden
                    && Number(this.activeConversationId) > 0
                    && inputValue.length > 0;
                const now = Date.now();
                if (this.socket && this.wsConnected
                    && (forceHeartbeat || typing !== this.supportTypingSent || (typing && now - this.supportTypingSentAt >= 900))) {
                    this.socket.send(JSON.stringify({
                        action: 'support_typing',
                        conversation_id: Number(this.activeConversationId),
                        typing
                    }));
                    this.supportTypingSent = typing;
                    this.supportTypingSentAt = now;
                }
                if (typing) {
                    this.supportTypingIdleTimer = window.setTimeout(() => this.syncSupportTyping(true), 900);
                }
            },

            stopSupportTyping() {
                if (this.supportTypingIdleTimer) {
                    window.clearTimeout(this.supportTypingIdleTimer);
                    this.supportTypingIdleTimer = null;
                }
                if (this.supportTypingSent && this.socket && this.wsConnected && Number(this.activeConversationId) > 0) {
                    this.socket.send(JSON.stringify({
                        action: 'support_typing',
                        conversation_id: Number(this.activeConversationId),
                        typing: false
                    }));
                }
                this.supportTypingSent = false;
                this.supportTypingSentAt = Date.now();
            },

            setSupportRemoteTyping(typing, label = '') {
                if (this.supportRemoteTypingTimer) window.clearTimeout(this.supportRemoteTypingTimer);
                this.supportRemoteTyping = typing === true;
                this.supportRemoteTypingLabel = this.supportRemoteTyping
                    ? String(label || this.humanSupportAgentLabel || 'Support team').slice(0, 80)
                    : '';
                if (this.supportRemoteTyping) {
                    this.supportRemoteTypingTimer = window.setTimeout(
                        () => this.setSupportRemoteTyping(false),
                        2600
                    );
                    this.$nextTick(() => this.scrollToBottom());
                }
            },

            handleWsMessage(data) {
                if (data.type === 'auth') {
                    this.isLoggedIn = data.isLoggedIn;
                    this.hasConversationHistory = data.historyAvailable === true;
                    this.chatSyncScope = String(data.historyScope || '');
                    this.initializeCrossTabSync();
                    const restoredGuestSnapshot = !this.isLoggedIn && this.restoreGuestSessionSnapshot();
                    if (!restoredGuestSnapshot) {
                        this.requestGuestSessionSnapshot();
                    }
                    if (this.hasConversationHistory) this.loadConversations();
                    return;
                }
                if (data.type === 'conversations') {
                    this.applyConversationPage(data);
                    return;
                }
                if (data.type === 'refresh_conversations') {
                    this.loadConversations();
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 80);
                    return;
                }
                if (data.type === 'support_message') {
                    const conversationId = Number(data.conversation_id) || 0;
                    if (conversationId === Number(this.activeConversationId)) {
                        this.setSupportRemoteTyping(false);
                    }
                    this.loadConversations();
                    if (conversationId && conversationId === Number(this.activeConversationId)) {
                        if (this.isLoading) {
                            this.pendingSupportConversationId = conversationId;
                        } else {
                            this.refreshSupportConversation(conversationId);
                        }
                    }
                    this.scheduleCrossTabConversationSync(conversationId, 80);
                    return;
                }
                if (data.type === 'support_message_mutation') {
                    this.applySupportMessageMutation(data);
                    this.loadConversations();
                    this.scheduleCrossTabConversationSync(Number(data.conversation_id) || 0, 80);
                    return;
                }
                if (data.type === 'support_message_mutation_result') {
                    if (data.status === 'success') {
                        this.applySupportMessageMutation(data);
                    } else {
                        this.clearSupportMessageMutationBusy(data.message_id);
                        this.setTransportNotice(
                            'support-message-mutation-failed',
                            'Message not changed',
                            data.message || 'The support message could not be changed.'
                        );
                    }
                    return;
                }
                if (data.type === 'support_typing') {
                    const conversationId = Number(data.conversation_id) || 0;
                    if (data.actor === 'admin'
                        && conversationId === Number(this.activeConversationId)
                        && this.humanSupportActive) {
                        this.setSupportRemoteTyping(data.typing === true, data.label || '');
                    }
                    return;
                }
                if (data.type === 'support_mode') {
                    const conversationId = Number(data.conversation_id) || 0;
                    if (!conversationId || conversationId === Number(this.activeConversationId)) {
                        this.humanSupportActive = data.active === true;
                        this.supportConversationClosed = data.closed === true;
                        this.humanSupportAgentLabel = this.humanSupportActive
                            ? String(data.agent_label || 'Support team').slice(0, 80)
                            : '';
                        if (!this.humanSupportActive) {
                            this.stopSupportTyping();
                            this.setSupportRemoteTyping(false);
                        }
                        if (this.humanSupportActive || this.supportConversationClosed) this.statusMessage = '';
                    }
                    return;
                }
                if (data.type === 'guest_new_chat') {
                    this.startNewChat(false);
                    return;
                }
                if (data.type === 'guest_history_reset') {
                    this.startNewChat(false);
                    return;
                }
                if (data.type === 'guest_order_access_state') {
                    this.applyGuestOrderAccessState(data.state, data.expires_at);
                    // The gateway is the authority for this status. Re-broadcast
                    // the status only as a same-browser delivery mechanism for
                    // tabs connected to a different gateway replica.
                    this.broadcastCrossTabEvent('guest_order_access_state', {
                        state: data.state === 'verified' ? 'verified' : 'email',
                        expires_at: data.expires_at || null
                    });
                    return;
                }
                if (data.type === 'guest_history_sync') {
                    this.loadConversations();
                    if (this.applyCrossTabMessageSnapshot(data.messages, data.conversation_id)) return;
                    this.switchConversation(data.conversation_id, true, {
                        preserveVisibleMessages: true
                    });
                    return;
                }
                if (data.type === 'conversation_messages') {
                    if (!this.isCurrentConversationResponse(data)) {
                        if (data.append === true) {
                            this.isLoadingOlderMessages = false;
                            this.historyScrollHeightBeforeLoad = 0;
                        }
                        return;
                    }
                    this.isLoading = false;
                    this.isCreatingNewChat = false;
                    this.applyConversationMessagePage(data, data.append === true);
                    return;
                }
                if (data.type === 'rename_result') {
                    if (data.status === 'success') {
                        this.applyConversationTitle(data.conversation_id, data.title || this.editingConversationDraft);
                        this.cancelConversationRename();
                        this.loadConversations();
                    } else {
                        this.setTransportNotice('conversation-rename-failed', 'Rename failed', data.message || 'The conversation title could not be updated.');
                    }
                    return;
                }
                if (data.type === 'delete_result') {
                    this.applyConversationDeleteResult(
                        data.conversation_id,
                        data.status === 'success',
                        data.message || ''
                    );
                    return;
                }
                this.handleStreamMessage(data);
            },

            initializeCrossTabSync() {
                if (!this.chatSyncScope) return;
                if (this.chatSyncTransport) return;

                if (typeof BroadcastChannel === 'function') {
                    try {
                        this.chatSyncChannel = new BroadcastChannel('afd-ai-chat-sync-v1');
                        this.chatSyncChannel.onmessage = (event) => this.handleCrossTabEvent(event.data);
                        window.addEventListener('beforeunload', () => this.chatSyncChannel?.close(), { once: true });
                        this.chatSyncTransport = 'broadcast';
                    } catch (error) {
                        this.chatSyncChannel = null;
                    }
                }

                if (this.chatSyncTransport) return;

                // Safari private windows and embedded browser shells can omit
                // BroadcastChannel. A short-lived storage event is a compatible
                // same-origin signal; the key is removed immediately and never
                // contains chat content or persisted history.
                try {
                    window.addEventListener('storage', (event) => {
                        if (event.key !== this.chatSyncStorageKey || !event.newValue) return;
                        try { this.handleCrossTabEvent(JSON.parse(event.newValue)); } catch (error) {}
                    });
                    this.chatSyncTransport = 'storage';
                } catch (error) {
                    this.chatSyncTransport = '';
                }
            },

            broadcastCrossTabEvent(type, payload = {}) {
                if (!this.chatSyncTransport || !this.chatSyncScope) return;
                const event = {
                    type,
                    scope: this.chatSyncScope,
                    source: this.chatSyncTabId,
                    nonce: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                    ...payload
                };
                if (this.chatSyncTransport === 'broadcast' && this.chatSyncChannel) {
                    this.chatSyncChannel.postMessage(event);
                    return;
                }
                try {
                    localStorage.setItem(this.chatSyncStorageKey, JSON.stringify(event));
                    localStorage.removeItem(this.chatSyncStorageKey);
                } catch (error) {}
            },

            scheduleCrossTabConversationSync(conversationId, delay = 0) {
                if (!conversationId || !this.chatSyncTransport) return;
                if (this.chatSyncTimer) window.clearTimeout(this.chatSyncTimer);
                this.chatSyncTimer = window.setTimeout(() => {
                    this.chatSyncTimer = null;
                    this.broadcastCrossTabEvent('conversation_sync', {
                        conversationId,
                        messages: this.crossTabMessageSnapshot()
                    });
                }, Math.max(0, Number(delay) || 0));
            },

            guestSessionSnapshotStorageKey() {
                if (this.isLoggedIn || !this.chatSyncScope) return '';
                return 'afd-ai-chat-guest-session-v1:' + this.chatSyncScope;
            },

            scheduleGuestSessionSnapshot(delay = 80) {
                if (this.isLoggedIn || !this.chatSyncScope) return;
                if (this.guestSessionSnapshotTimer) {
                    window.clearTimeout(this.guestSessionSnapshotTimer);
                }
                this.guestSessionSnapshotTimer = window.setTimeout(() => {
                    this.guestSessionSnapshotTimer = null;
                    this.persistGuestSessionSnapshot();
                }, Math.max(0, Number(delay) || 0));
            },

            persistGuestSessionSnapshot() {
                const key = this.guestSessionSnapshotStorageKey();
                if (!key) return;

                try {
                    if (!this.hasStartedChat || !Array.isArray(this.messages) || this.messages.length === 0) {
                        sessionStorage.removeItem(key);
                        return;
                    }

                    const snapshot = {
                        version: 1,
                        conversationId: this.activeConversationId || null,
                        title: this.getGuestSessionTitle(this.messages, this.activeConversationId),
                        updatedAt: new Date().toISOString(),
                        messages: this.crossTabMessageSnapshot()
                    };
                    sessionStorage.setItem(key, JSON.stringify(snapshot));
                } catch (error) {
                    // Images can exceed the browser's session-storage quota.
                    // Preserve the conversation text rather than discarding the
                    // entire guest session when that happens.
                    try {
                        const textOnlySnapshot = {
                            version: 1,
                            conversationId: this.activeConversationId || null,
                            title: this.getGuestSessionTitle(this.messages, this.activeConversationId),
                            updatedAt: new Date().toISOString(),
                            messages: this.crossTabMessageSnapshot().map((message) => ({
                                ...message,
                                attachments: []
                            }))
                        };
                        sessionStorage.setItem(key, JSON.stringify(textOnlySnapshot));
                    } catch (fallbackError) {}
                }
            },

            restoreGuestSessionSnapshot() {
                const key = this.guestSessionSnapshotStorageKey();
                if (!key) return false;

                try {
                    const snapshot = JSON.parse(sessionStorage.getItem(key) || 'null');
                    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.messages)) {
                        return false;
                    }
                    if (!this.applyCrossTabMessageSnapshot(snapshot.messages, snapshot.conversationId)) {
                        return false;
                    }

                    this.guestSessionSnapshotRestored = true;
                    const snapshotTitle = this.getGuestSessionTitle(
                        snapshot.messages,
                        snapshot.conversationId,
                        snapshot.title
                    );
                    if (snapshot.conversationId && !this.conversations.some(
                        (conversation) => Number(conversation.id) === Number(snapshot.conversationId)
                    )) {
                        this.conversations = [{
                            id: snapshot.conversationId,
                            title: snapshotTitle,
                            updated_at: String(snapshot.updatedAt || '')
                        }];
                    }
                    return true;
                } catch (error) {
                    return false;
                }
            },

            getGuestSessionTitle(messages = this.messages, conversationId = this.activeConversationId, fallback = '') {
                const currentConversation = this.conversations.find(
                    (conversation) => Number(conversation.id) === Number(conversationId)
                );
                const savedTitle = String(currentConversation?.title || fallback || '').trim();
                if (savedTitle && !/^current (?:chat|session)$/i.test(savedTitle)) {
                    return savedTitle.slice(0, 255);
                }

                const firstCustomerMessage = (Array.isArray(messages) ? messages : []).find((message) => (
                    message?.role === 'user' && String(message.content || '').trim()
                ));
                const derivedTitle = String(firstCustomerMessage?.content || '')
                    .replace(/\s+/g, ' ')
                    .trim();

                return (derivedTitle || savedTitle || 'Current chat').slice(0, 255);
            },

            clearGuestSessionSnapshot() {
                if (this.guestSessionSnapshotTimer) {
                    window.clearTimeout(this.guestSessionSnapshotTimer);
                    this.guestSessionSnapshotTimer = null;
                }
                const key = this.guestSessionSnapshotStorageKey();
                if (!key) return;
                try { sessionStorage.removeItem(key); } catch (error) {}
                this.guestSessionSnapshotRestored = false;
            },

            requestGuestSessionSnapshot() {
                if (this.isLoggedIn || this.chatSyncTransport !== 'broadcast') return;
                this.broadcastCrossTabEvent('guest_snapshot_request');
            },

            crossTabMessageSnapshot() {
                return this.messages.slice(-100).map((message) => ({
                    entity_id: Number(message.entity_id) || null,
                    role: message.role,
                    source: message.source === 'support_agent' ? 'support_agent' : '',
                    senderLabel: String(message.senderLabel || '').slice(0, 80),
                    content: String(message.content || ''),
                    feedbackEnabled: message.feedbackEnabled === true,
                    feedback: ['positive', 'negative'].includes(String(message.feedback || ''))
                        ? String(message.feedback)
                        : null,
                    feedbackReason: String(message.feedbackReason || '').slice(0, 64),
                    feedbackComment: String(message.feedbackComment || '').slice(0, 1000),
                    feedbackDetailsSaved: message.feedbackDetailsSaved === true,
                    interrupted: message.interrupted === true,
                    stoppedAfterSeconds: Math.max(0, Number(message.stoppedAfterSeconds) || 0),
                    attachments: Array.isArray(message.attachments) ? message.attachments.map((attachment) => ({
                        name: String(attachment.name || 'image'),
                        size: Number(attachment.size) || 0,
                        type: String(attachment.type || ''),
                        previewUrl: String(attachment.previewUrl || '')
                    })) : [],
                    parts: Array.isArray(message.parts) ? message.parts.map((part) => ({
                        type: part.type,
                        raw: String(part.raw || ''),
                        // Alpine makes nested data reactive. BroadcastChannel
                        // accepts only structured-cloneable values, so turn the
                        // catalogue payload into a plain JSON record before it
                        // crosses to another tab. Keeping this field matters for
                        // product follow-up questions after a tab sync.
                        payload: this.serializeCrossTabPayload(part.payload),
                        html: part.type === 'products' ? String(part.html || '') : '',
                        ...(part.type === 'image' ? {
                            imageId: String(part.imageId || ''),
                            status: String(part.status || 'complete'),
                            url: String(part.url || ''),
                            alt: String(part.alt || 'Generated image'),
                            prompt: String(part.prompt || '').slice(0, 4000),
                            size: String(part.size || ''),
                            quality: String(part.quality || '')
                        } : {}),
                        ...(part.type === 'guest_order_access' ? {
                            purpose: part.purpose === 'support' ? 'support' : 'order',
                            state: part.state === 'verified' ? 'verified' : (part.state === 'expired' ? 'expired' : 'email'),
                            expires_at: Math.max(0, Number(part.expiresAt) || 0),
                            tickets: Array.isArray(part.tickets) ? this.serializeCrossTabPayload(part.tickets) : []
                        } : {}),
                        ...(part.type === 'order_address_form' ? {
                            resource_type: part.resourceType === 'customer_account' ? 'customer_account' : 'order',
                            form_id: String(part.id || ''),
                            action_token: String(part.actionToken || ''),
                            created_at: Math.max(0, Number(part.createdAt) || 0),
                            expires_at: Math.max(0, Number(part.expiresAt) || 0),
                            access_scope: part.accessScope === 'customer' ? 'customer' : 'guest',
                            order_number: String(part.orderNumber || ''),
                            address_types: Array.isArray(part.addressTypes) ? [...part.addressTypes] : [],
                            address_type: String(part.addressType || ''),
                            addresses: this.serializeCrossTabPayload(part.addresses) || {},
                            fields: this.serializeCrossTabPayload(part.fields) || [],
                            countries: this.serializeCrossTabPayload(part.countries) || [],
                            regions: this.serializeCrossTabPayload(part.regions) || {}
                        } : {}),
                    })) : []
                }));
            },

            serializeCrossTabPayload(payload) {
                if (!payload || typeof payload !== 'object') return null;
                try {
                    return JSON.parse(JSON.stringify(payload));
                } catch (error) {
                    // The product grid HTML remains usable. Omit only a payload
                    // that cannot be safely carried to another browser tab.
                    return null;
                }
            },

            applyCrossTabMessageSnapshot(messages, conversationId) {
                if (!Array.isArray(messages) || messages.length === 0) return false;
                // A browser snapshot is useful for message content only. It is
                // never an authority for guest-order access: an old snapshot
                // can outlive a gateway restart or an expired OTP token.
                const effectiveGuestOrderAccessState = this.guestOrderAccessState === 'verified'
                    ? 'verified'
                    : 'email';
                this.activeConversationId = conversationId;
                this.messages = messages.map((message) => {
                    const role = message.role === 'user' ? 'user' : 'assistant';
                    const entityId = Number(message.entity_id) || null;
                    const source = message.source === 'support_agent' ? 'support_agent' : '';
                    const feedback = ['positive', 'negative'].includes(String(message.feedback || ''))
                        ? String(message.feedback)
                        : null;

                    return {
                        entity_id: entityId,
                        role,
                        source,
                        senderLabel: source === 'support_agent'
                            ? String(message.senderLabel || 'Support team').slice(0, 80)
                            : '',
                        content: role === 'user'
                            ? String(message.content || '')
                            : sanitizeCustomerResponseText(message.content || ''),
                        feedbackEnabled: role === 'assistant'
                            && source !== 'support_agent'
                            && entityId !== null
                            && message.feedbackEnabled === true,
                        feedback,
                        feedbackReason: String(message.feedbackReason || ''),
                        feedbackComment: String(message.feedbackComment || ''),
                        feedbackDetailsSaved: message.feedbackDetailsSaved === true,
                        // Busy is transport-only state. Never carry it across tabs
                        // or reloads, otherwise a closed/aborted request can leave
                        // both rating buttons disabled forever.
                        feedbackBusy: false,
                        interrupted: message.interrupted === true,
                        stoppedAfterSeconds: Math.max(
                            0,
                            Number(message.stoppedAfterSeconds ?? message.stopped_after_seconds) || 0
                        ),
                        attachments: Array.isArray(message.attachments) ? message.attachments : [],
                        parts: Array.isArray(message.parts) ? message.parts.map((part) => (
                            part.type === 'products'
                                ? { id: Date.now() + Math.random(), type: 'products', payload: part.payload || null, html: hydrateProductGridHtml(part.html || '') }
                                : part.type === 'image' && /^(?:https?:\/\/|\/media\/)/i.test(String(part.url || ''))
                                    ? {
                                        id: Date.now() + Math.random(),
                                        imageId: String(part.imageId || ''),
                                        type: 'image',
                                        status: String(part.status || 'complete'),
                                        url: String(part.url),
                                        alt: String(part.alt || 'Generated image'),
                                        prompt: String(part.prompt || '').slice(0, 4000),
                                        size: String(part.size || ''),
                                        quality: String(part.quality || '')
                                    }
                                : part.type === 'guest_order_access'
                                    ? this.createGuestOrderAccessPart({
                                        ...part,
                                        form_id: Date.now() + Math.random(),
                                        state: part.purpose === 'support' ? part.state : effectiveGuestOrderAccessState
                                    })
                                : part.type === 'order_address_form'
                                    ? this.createOrderAddressFormPart(part)
                                : (() => {
                                    const raw = sanitizeCustomerResponseText(part.raw || '');
                                    return { id: Date.now() + Math.random(), type: 'text', raw, html: sanitizeHtml(raw) };
                                })()
                        )) : []
                    };
                });
                this.enforceSingleActiveOrderAddressForm();
                this.hasStartedChat = true;
                this.isCreatingNewChat = false;
                this.isLoading = false;
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => this.scrollToBottom(true));
                return true;
            },

            handleCrossTabEvent(event) {
                if (!event || event.source === this.chatSyncTabId || event.scope !== this.chatSyncScope) return;

                if (event.type === 'new_chat') {
                    this.startNewChat(false);
                    return;
                }

                if (event.type === 'guest_order_access_state') {
                    this.applyGuestOrderAccessState(event.state, event.expires_at);
                    return;
                }

                if (event.type === 'guest_snapshot_request') {
                    if (!this.isLoggedIn && this.hasStartedChat) {
                        this.broadcastCrossTabEvent('guest_snapshot_response', {
                            target: event.source,
                            conversationId: this.activeConversationId,
                            messages: this.crossTabMessageSnapshot()
                        });
                    }
                    return;
                }

                if (event.type === 'guest_snapshot_response' && event.target === this.chatSyncTabId) {
                    this.applyCrossTabMessageSnapshot(event.messages, event.conversationId);
                    return;
                }

                if (event.type !== 'conversation_sync' || !event.conversationId) return;

                this.loadConversations();
                if (this.applyCrossTabMessageSnapshot(event.messages, event.conversationId)) return;
                this.switchConversation(event.conversationId, true, {
                    preserveVisibleMessages: true
                });
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
