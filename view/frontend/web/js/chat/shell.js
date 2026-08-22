/** shellMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.shellMethods = function (context) {
        const { config, urls } = context;
        const {
            sanitizeHtml,
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
            t(key, params = {}) {
                const configTranslations = config?.translations || window.afdAiChatConfig?.translations || {};
                let text = configTranslations[key] || key;
                if (params && typeof params === 'object') {
                    for (const [paramKey, paramVal] of Object.entries(params)) {
                        text = text.replace(new RegExp(`%${paramKey}|\\{${paramKey}\\}`, 'g'), String(paramVal));
                        text = text.replace(/%1/g, String(paramVal));
                    }
                }
                return text;
            },
            scrollToBottom(force = false) {
                this.$nextTick(() => {
                    const chatWindow = document.getElementById('chatWindow');
                    if (!chatWindow) return;

                    // Streaming used to reset scrollTop on every chunk. That
                    // made it impossible to inspect an earlier answer while
                    // the assistant was still writing. Match the expected
                    // chat behaviour: follow only when the reader is already
                    // at the end, otherwise leave their reading position intact.
                    if (!force && !this.isAtChatBottom) {
                        this.hasUnreadMessages = true;
                        return;
                    }

                    chatWindow.scrollLeft = 0;
                    const maxScrollTop = Math.max(0, chatWindow.scrollHeight - chatWindow.clientHeight);
                    chatWindow.scrollTop = maxScrollTop;
                    this.isAtChatBottom = true;
                    this.hasUnreadMessages = false;
                });
            },

            handleMessageScroll(event) {
                const chatWindow = event?.currentTarget;
                if (!chatWindow) return;

                const distanceFromBottom = chatWindow.scrollHeight
                    - chatWindow.scrollTop
                    - chatWindow.clientHeight;
                this.isAtChatBottom = distanceFromBottom <= 40;
                if (this.isAtChatBottom) {
                    this.hasUnreadMessages = false;
                }
            },

            showScrollToLatest() {
                return !this.isAtChatBottom;
            },

            scrollToLatest() {
                this.scrollToBottom(true);
            },

            // Helper for SyntaxError protection
            shouldShowHistory() {
                return this.hasConversationHistory && this.conversations.length > 0;
            },
            shouldShowCurrentSession() {
                if (!this.hasStartedChat) return false;
                return !this.activeConversationId;
            },
            // A streamed message is replaced with its durable counterpart
            // shortly after completion. Persist this view key on the message
            // so Alpine retains its existing DOM node rather than removing
            // and recreating the whole reply during that hydration.
            messageRenderKey(message, index = -1) {
                if (!message || typeof message !== 'object') {
                    return 'message-missing-' + index;
                }
                if (message.render_key) return String(message.render_key);

                const entityId = Number(message.entity_id) || 0;
                if (entityId) {
                    message.render_key = 'message-' + entityId;
                    return message.render_key;
                }

                const role = String(message.role || 'message');
                const requestId = String(message.request_id || '');
                const createdAt = String(message.created_at || message.createdAt || '');
                const suffix = requestId || createdAt || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
                message.render_key = 'live-' + role + '-' + suffix;
                return message.render_key;
            },
            shouldShowMessage(msg, index = -1) {
                if (!msg) return false;
                if (msg.deleted === true) return true;
                // While a customer edits a turn, hide its old reply branch.
                // The current user item stays visible because it contains the
                // inline editor; submitting it then replaces that branch in
                // durable history too.
                if (!this.humanSupportActive
                    && this.editingMessageIndex !== null
                    && index > this.editingMessageIndex) return false;
                if (msg.role === 'user') return true;
                if (msg.interrupted === true) return true;
                if (!Array.isArray(msg.parts)) return false;

                // A structured part is still a complete assistant message
                // even when it intentionally has no HTML. Guest order access
                // and the order-address card are rendered inline, so omitting
                // either made the live message disappear while the same
                // persisted turn showed up again after history hydration.
                return msg.parts.some((part) => (
                    part?.type === 'guest_order_access'
                    || part?.type === 'order_address_form'
                    || part?.type === 'products'
                    || part?.type === 'reasoning'
                    || (part?.type === 'text' && part.streaming === true)
                    || (part?.type === 'image' && (
                        part.status === 'generating'
                        || part.status === 'error'
                        || part.url
                    ))
                    || (typeof part?.html === 'string' && part.html.trim().length > 0)
                    || (typeof part?.raw === 'string' && part.raw.trim().length > 0)
                ));
            },
            handleSuggestionClick(text) {
                this.sendSuggestion(text);
            },
            getConnectionStatusText() {
                return this.wsConnected ? 'Live' : 'Ready';
            },
            shouldShowBubble() {
                return !this.isOpen && this.showBubble;
            },
            shouldShowBadge() {
                return !this.isOpen && this.showBubble;
            },

            hasStreamingText(message) {
                return Array.isArray(message?.parts)
                    && message.parts.some(part => part?.type === 'text' && part.streaming === true);
            },

            shouldShowMessageActions(message, index) {
                if (!message || message.deleted || message.role !== 'assistant') {
                    return false;
                }
                // Never show actions while text is streaming
                if (this.hasStreamingText(message)) {
                    return false;
                }
                // Never show actions on the active turn while thinking or loading
                if (this.isLoading && (index === this.currentAiMessageIndex || index === this.messages.length - 1)) {
                    return false;
                }
                // Only show actions if there is actual customer-facing answer content
                const parts = Array.isArray(message.parts) ? message.parts : [];
                return parts.some(p => (
                    (p?.type === 'text' && String(p.raw || p.html || '').trim().length > 0)
                    || p?.type === 'products'
                    || p?.type === 'image'
                    || p?.type === 'order_address_form'
                    || p?.type === 'guest_order_access'
                ));
            },

            openChat() {
                // This is a user-visible history hydration. Keep the loading
                // cover until the first history result is ready; background
                // tab synchronization must not use this state.
                if (!this.isOpen && !this.hasStartedChat) {
                    this.isHistoryLoading = true;
                    this.armHistoryLoadingTimeout?.();
                }
                this.isOpen = true;
                this.showBubble = false;
                if (typeof modules.loadRichTextAssets !== 'function') {
                    this.ensureWebSocketConnection();
                    return;
                }
                this.richTextAssetsPromise = modules.loadRichTextAssets(config.richTextAssets || {});
                this.richTextAssetsPromise
                    .catch(() => null)
                    .finally(() => this.ensureWebSocketConnection());
            },
            closeChat() {
                this.isOpen = false;
                this.closeImageViewer();
                this.closeHistorySearch(false);
                this.closeMobileSidebar();
                this.petHovering = false;
                this.cancelEditMessage();
                this.cancelConversationRename();
                if (this.wsReconnectTimer) {
                    window.clearTimeout(this.wsReconnectTimer);
                    this.wsReconnectTimer = null;
                }
                if (!this.wsHasEverConnected) {
                    this.connectionAttempted = false;
                }
            },
            toggleChat() {
                this.isOpen ? this.closeChat() : this.openChat();
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
