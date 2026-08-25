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
        const CHAT_BOTTOM_TOLERANCE = 40;
        // Keep a fresh customer turn slightly above centre, leaving room for
        // its Thinking/output to grow below just like the Codex thread view.
        const NEW_TURN_VIEWPORT_OFFSET_RATIO = 0.36;
        const NEW_TURN_SPACER_VIEWPORT_RATIO = 0.70;
        let observedMessageScrollElement = null;
        let observedMessageContent = null;
        let messageContentResizeObserver = null;
        let messageContentMutationObserver = null;
        let messageContentLoadHandler = null;
        let messageUserScrollIntentHandler = null;
        let userScrollIntentUntil = 0;
        let followScrollFrame = null;
        let settleScrollFrame = null;
        let pendingForcedFollow = false;
        let pendingUnreadNotification = false;

        const requestFrame = callback => {
            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                callback();
                return null;
            }
            return window.requestAnimationFrame(callback);
        };

        const cancelFrame = frame => {
            if (frame !== null
                && typeof window !== 'undefined'
                && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(frame);
            }
        };

        const isRenderedChatMessage = message => {
            const height = Number(message?.getBoundingClientRect?.().height);
            // Unit-test doubles only expose `top`, while real x-show-hidden
            // branches have a measured height of zero.
            return !Number.isFinite(height) || height > 0;
        };

        const disconnectMessageContentObserver = () => {
            cancelFrame(followScrollFrame);
            cancelFrame(settleScrollFrame);
            followScrollFrame = null;
            settleScrollFrame = null;
            pendingForcedFollow = false;
            pendingUnreadNotification = false;
            messageContentResizeObserver?.disconnect();
            messageContentMutationObserver?.disconnect();
            if (observedMessageScrollElement && messageContentLoadHandler) {
                observedMessageScrollElement.removeEventListener('load', messageContentLoadHandler, true);
            }
            if (observedMessageScrollElement && messageUserScrollIntentHandler) {
                ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach(type => {
                    observedMessageScrollElement.removeEventListener(type, messageUserScrollIntentHandler, true);
                });
            }
            observedMessageScrollElement = null;
            observedMessageContent = null;
            messageContentResizeObserver = null;
            messageContentMutationObserver = null;
            messageContentLoadHandler = null;
            messageUserScrollIntentHandler = null;
            userScrollIntentUntil = 0;
        };

        const followMessageContent = (scope, chatWindow, force = false, markUnreadWhenNotFollowing = true) => {
            if (!chatWindow) return false;
            if (!force && typeof scope.shouldKeepCurrentTurnAtTop === 'function'
                && scope.shouldKeepCurrentTurnAtTop(chatWindow)) {
                // `done` can restore the turn intent while the spacer is
                // still hidden. Once Alpine paints that spacer, there is new
                // scroll range below a short response. Re-run the actual
                // placement here so the submitted message moves back to the
                // reading position instead of remaining pinned at the former
                // bottom edge.
                scope.pinCurrentTurnToTop?.(scope.pinnedTurnRequestId);
                scope.isAtChatBottom = true;
                scope.hasUnreadMessages = false;
                return true;
            }
            if (!force && scope.isAtChatBottom === false) {
                if (markUnreadWhenNotFollowing) scope.hasUnreadMessages = true;
                return false;
            }

            chatWindow.scrollLeft = 0;
            chatWindow.scrollTop = Math.max(0, chatWindow.scrollHeight - chatWindow.clientHeight);
            scope.isAtChatBottom = true;
            scope.hasUnreadMessages = false;
            return true;
        };

        const scheduleMessageContentFollow = (
            scope,
            chatWindow,
            force = false,
            markUnreadWhenNotFollowing = true
        ) => {
            if (!chatWindow || (observedMessageScrollElement && observedMessageScrollElement !== chatWindow)) return;
            pendingForcedFollow = pendingForcedFollow || force;
            pendingUnreadNotification = pendingUnreadNotification || markUnreadWhenNotFollowing;
            if (followScrollFrame !== null) return;

            followScrollFrame = requestFrame(() => {
                followScrollFrame = null;
                if (observedMessageScrollElement && observedMessageScrollElement !== chatWindow) return;
                const mustFollow = pendingForcedFollow;
                const shouldMarkUnread = pendingUnreadNotification;
                pendingForcedFollow = false;
                pendingUnreadNotification = false;
                if (!followMessageContent(scope, chatWindow, mustFollow, shouldMarkUnread)) return;

                // Alpine/Markdown can paint after the frame that changed the
                // reactive part. A second settle frame prevents a stale
                // scrollHeight from leaving the latest line just out of view.
                settleScrollFrame = requestFrame(() => {
                    settleScrollFrame = null;
                    if (observedMessageScrollElement && observedMessageScrollElement !== chatWindow) return;
                    followMessageContent(scope, chatWindow);
                });
            });
        };

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
            observeMessageScrollContent(chatWindow) {
                if (!chatWindow) return;
                const content = typeof chatWindow.querySelector === 'function'
                    ? chatWindow.querySelector('[data-role="chat-scroll-content"]')
                    : null;
                if (observedMessageScrollElement === chatWindow && observedMessageContent === content) return;

                disconnectMessageContentObserver();
                observedMessageScrollElement = chatWindow;
                observedMessageContent = content;

                const followAfterContentChange = entries => {
                    // A viewport resize must preserve a reader's position if
                    // they are inspecting older output. A content resize is
                    // new output, so only that case earns the unread label.
                    const contentChanged = !content || !Array.isArray(entries)
                        || entries.some(entry => entry?.target === content);
                    scheduleMessageContentFollow(this, chatWindow, false, contentChanged);
                };
                if (typeof ResizeObserver !== 'undefined') {
                    messageContentResizeObserver = new ResizeObserver(followAfterContentChange);
                    messageContentResizeObserver.observe(chatWindow);
                    if (content) messageContentResizeObserver.observe(content);
                } else if (typeof MutationObserver !== 'undefined') {
                    messageContentMutationObserver = new MutationObserver(() => followAfterContentChange());
                    messageContentMutationObserver.observe(content || chatWindow, {
                        childList: true,
                        subtree: true,
                        characterData: true
                    });
                }

                // Image dimensions can settle after the streaming Markdown
                // render. Capture their load event so a pinned conversation
                // still follows the final rendered height.
                messageContentLoadHandler = event => {
                    if (event?.target?.tagName === 'IMG') followAfterContentChange();
                };
                chatWindow.addEventListener?.('load', messageContentLoadHandler, true);

                // A browser fires `scroll` for layout anchoring and for our
                // own scrollTop writes. Those events must not be mistaken for
                // the reader leaving the latest response. Only a recent
                // direct input gesture is allowed to stop auto-following.
                messageUserScrollIntentHandler = event => {
                    // Codex preserves an active short-turn reading anchor
                    // through wheel movement while output is streaming. A
                    // wheel event is not enough to cancel that anchor: the
                    // next rendered chunk must remain in the reading area,
                    // not jump back beside the composer.
                    if (event?.type === 'wheel'
                        && this.isTurnStartPinned
                        && this.pinnedTurnRequestId) return;
                    // A normal click on a link, an action, or the Thinking
                    // disclosure is not a request to stop following. Native
                    // scrollbar drags target the scroll element itself.
                    if (event?.type === 'pointerdown' && event.target !== chatWindow) return;
                    userScrollIntentUntil = Date.now() + 500;
                };
                ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach(type => {
                    chatWindow.addEventListener?.(type, messageUserScrollIntentHandler, true);
                });
            },

            currentTurnUserMessage(chatWindow, requestId = this.pinnedTurnRequestId) {
                if (!chatWindow || !requestId || typeof chatWindow.querySelectorAll !== 'function') return null;
                const messages = Array.from(chatWindow.querySelectorAll('[data-role="chat-user-message"]'));
                return messages.find(message => message?.dataset?.requestId === String(requestId)
                    && isRenderedChatMessage(message))
                    || messages.filter(isRenderedChatMessage).at(-1)
                    || null;
            },

            currentTurnAnchorMessage(chatWindow, requestId = this.pinnedTurnRequestId) {
                // Keep one stable reading anchor for the whole turn. Moving
                // it from the customer bubble to the assistant bubble when
                // the first chunk arrives visibly jumps the transcript.
                return this.currentTurnUserMessage(chatWindow, requestId);
            },

            currentTurnAnchorSpacerHeight() {
                const chatWindow = typeof document !== 'undefined'
                    ? document.getElementById('chatWindow')
                    : null;
                return chatWindow
                    ? Math.ceil(Math.max(0, Number(chatWindow.clientHeight) || 0) * NEW_TURN_SPACER_VIEWPORT_RATIO)
                    : 0;
            },

            shouldKeepCurrentTurnAtTop(chatWindow) {
                if (!this.isTurnStartPinned || !this.pinnedTurnRequestId || !chatWindow) return false;
                const anchorMessage = typeof this.currentTurnAnchorMessage === 'function'
                    ? this.currentTurnAnchorMessage(chatWindow)
                    : this.currentTurnUserMessage(chatWindow);
                if (!anchorMessage || typeof anchorMessage.getBoundingClientRect !== 'function'
                    || typeof chatWindow.getBoundingClientRect !== 'function') {
                    // The request is already active but Alpine has not yet
                    // mounted its user bubble. Preserve the intent during
                    // that one-render gap; otherwise an early status frame
                    // can put the conversation back at the bottom first.
                    if (this.isLoading && String(this.activeRequestId || '') === this.pinnedTurnRequestId) {
                        return true;
                    }
                    this.isTurnStartPinned = false;
                    this.pinnedTurnRequestId = '';
                    return false;
                }

                const anchorTop = chatWindow.scrollTop
                    + anchorMessage.getBoundingClientRect().top
                    - chatWindow.getBoundingClientRect().top;
                const spacer = typeof chatWindow.querySelector === 'function'
                    ? chatWindow.querySelector('[data-role="chat-turn-anchor-spacer"]')
                    : null;
                const spacerHeight = Math.max(
                    0,
                    Number(spacer?.getBoundingClientRect?.().height)
                        || Number(spacer?.offsetHeight)
                        || 0
                );
                // The spacer creates the scroll range required to move a
                // short turn upward. It is not response content, so exclude
                // it when deciding whether the real turn has grown tall.
                const turnHeight = chatWindow.scrollHeight - spacerHeight - Math.max(0, anchorTop);
                if (turnHeight <= Math.max(0, chatWindow.clientHeight - 16)) return true;

                this.isTurnStartPinned = false;
                this.pinnedTurnRequestId = '';
                return false;
            },

            pinCurrentTurnToTop(requestId) {
                const chatWindow = typeof document !== 'undefined'
                    ? document.getElementById('chatWindow')
                    : null;
                const normalizedRequestId = String(requestId || '');
                if (!normalizedRequestId) {
                    this.isTurnStartPinned = false;
                    this.pinnedTurnRequestId = '';
                    return;
                }

                // Set the intent before querying the DOM. Streaming status
                // frames can arrive in the same event loop as the submit.
                this.isTurnStartPinned = true;
                this.pinnedTurnRequestId = normalizedRequestId;
                if (!chatWindow) return;

                const anchorMessage = typeof this.currentTurnAnchorMessage === 'function'
                    ? this.currentTurnAnchorMessage(chatWindow, normalizedRequestId)
                    : this.currentTurnUserMessage(chatWindow, normalizedRequestId);
                if (!anchorMessage || typeof anchorMessage.getBoundingClientRect !== 'function'
                    || typeof chatWindow.getBoundingClientRect !== 'function') return;

                const targetTop = Math.max(
                    0,
                    chatWindow.scrollTop
                        + anchorMessage.getBoundingClientRect().top
                        - chatWindow.getBoundingClientRect().top
                        - (chatWindow.clientHeight * NEW_TURN_VIEWPORT_OFFSET_RATIO)
                );
                chatWindow.scrollLeft = 0;
                chatWindow.scrollTop = targetTop;
                // This is still an automatic following mode even though the
                // current turn is top-aligned, so do not expose “Latest”.
                this.isAtChatBottom = true;
                this.hasUnreadMessages = false;
            },

            scrollToBottom(force = false) {
                const afterRender = () => {
                    const chatWindow = typeof document !== 'undefined'
                        ? document.getElementById('chatWindow')
                        : null;
                    if (!chatWindow) return;
                    this.observeMessageScrollContent(chatWindow);
                    scheduleMessageContentFollow(this, chatWindow, force);
                };

                if (typeof this.$nextTick === 'function') {
                    this.$nextTick(afterRender);
                    return;
                }
                afterRender();
            },

            handleMessageScroll(event) {
                const chatWindow = event?.currentTarget;
                if (!chatWindow) return;

                const distanceFromBottom = chatWindow.scrollHeight
                    - chatWindow.scrollTop
                    - chatWindow.clientHeight;
                if (distanceFromBottom <= CHAT_BOTTOM_TOLERANCE) {
                    this.isAtChatBottom = true;
                    this.hasUnreadMessages = false;
                    return;
                }

                // Keep following through DOM-originated scroll events. Once
                // the reader genuinely scrolls up, that choice persists
                // until they return to the bottom or choose “Latest”.
                if (Date.now() <= userScrollIntentUntil) {
                    this.isAtChatBottom = false;
                    this.isTurnStartPinned = false;
                    this.pinnedTurnRequestId = '';
                }
            },

            showScrollToLatest() {
                return !this.isAtChatBottom;
            },

            scrollToLatest() {
                this.isTurnStartPinned = false;
                this.pinnedTurnRequestId = '';
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
                // Codex keeps the existing transcript visible while an older
                // customer message is edited. Only submitting the edit replaces
                // that later branch; merely opening the inline form must not
                // make the subsequent conversation disappear.
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
                    .catch((error) => {
                        // Not fatal: helpers.js fails closed and renders the
                        // markdown source as escaped plain text until (or if)
                        // Marked/DOMPurify become available. Surface the
                        // degradation instead of swallowing it.
                        console.warn('[AFD-AI-CHAT] Rich-text libraries failed to load; markdown renders as plain text.', error);
                        return null;
                    })
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
