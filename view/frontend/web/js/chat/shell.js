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
                    chatWindow.scrollTop = chatWindow.scrollHeight;
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
                    || (part?.type === 'text' && part.streaming === true)
                    || (part?.type === 'image' && (
                        part.status === 'generating'
                        || part.status === 'error'
                        || part.url
                    ))
                    || (typeof part?.html === 'string' && part.html.trim().length > 0)
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
            openChat() {
                if (!this.isOpen && !this.wsHasEverConnected && !this.hasStartedChat) {
                    this.isHistoryLoading = true;
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
