/** historyMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.historyMethods = function (context) {
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

        const messageHydrationFingerprint = (message = {}) => {
            const parts = Array.isArray(message.parts) ? message.parts : [];
            const textFromParts = parts
                .filter(part => String(part?.type || 'text') === 'text')
                .map(part => String(part?.raw || part?.content || ''))
                .filter(Boolean)
                .join('\n\n');
            const normalizedParts = parts.map((part) => {
                const type = String(part?.type || 'text');
                if (type === 'products') {
                    return [
                        type,
                        Array.isArray(part?.payload?.product_ids)
                            ? part.payload.product_ids.map(id => Number(id) || 0).filter(Boolean)
                            : []
                    ];
                }
                if (type === 'image') return [type, String(part?.url || '')];
                return [type, String(part?.raw || part?.content || '')];
            });

            return JSON.stringify([
                message.role === 'user' ? 'user' : 'assistant',
                String(message.source || ''),
                // Live streaming messages deliberately keep text in `parts`
                // until finalization, whereas durable history also has a
                // flattened `content` field. Prefer the shared part text so
                // those two representations resolve to one turn.
                textFromParts || String(message.content || ''),
                normalizedParts
            ]);
        };

        return {
            loadConversations(page = 1, append = false) {
                const requestedPage = Math.max(1, Number(page) || 1);
                if (append) {
                    if (this.isLoadingMoreConversations || !this.hasMoreConversations) return;
                    this.isLoadingMoreConversations = true;
                } else {
                    this.isLoadingMoreConversations = false;
                }

                if (this.socket && this.wsConnected) {
                    this.socket.send(JSON.stringify({
                        action: 'list_conversations',
                        page: requestedPage,
                        append
                    }));
                } else {
                    this.loadConversationsHTTP(requestedPage, append);
                }
            },

            applyConversationPage(data) {
                const pageConversations = Array.isArray(data.conversations) ? data.conversations : [];
                const append = data.append === true;
                this.isLoadingMoreConversations = false;
                this.hasConversationHistory = data.historyAvailable === true;
                this.conversationPage = Math.max(1, Number(data.page) || 1);
                this.hasMoreConversations = data.has_more === true;
                this.nextConversationPage = Number(data.next_page) || null;

                if (!append) {
                    this.conversations = pageConversations;
                    // A guest snapshot is an offline/reconnect fallback only.
                    // Once the durable conversation list arrives, reload the
                    // active conversation from Magento so newly supported
                    // structured parts (for example the guest order email
                    // verification card) are not stranded in an old browser
                    // snapshot after a page refresh.
                    const restoredConversationId = Number(this.activeConversationId) || null;
                    const hasRestoredConversation = !this.isLoggedIn
                        && this.guestSessionSnapshotRestored
                        && restoredConversationId
                        && pageConversations.some(
                            conversation => Number(conversation.id) === restoredConversationId
                        );
                    if (hasRestoredConversation) {
                        // Consume the snapshot restore before the forced
                        // hydration. A response persistence emits
                        // `refresh_conversations`; without resetting this
                        // one-shot flag, each refresh clears the message list
                        // and reloads it again, creating a visible flicker.
                        this.guestSessionSnapshotRestored = false;
                        this.switchConversation(restoredConversationId, true, {
                            preserveVisibleMessages: true
                        });
                        return;
                    }

                    if (!this.isLoggedIn
                        && this.guestSessionSnapshotRestored
                        && this.activeConversationId
                        && pageConversations.length === 0) {
                        this.conversations = [{
                            id: this.activeConversationId,
                            title: 'Current chat',
                            updated_at: new Date().toISOString()
                        }];
                    }
                    // Restore the newest conversation whenever the server
                    // provides history and no thread is currently active.
                    // `isCreatingNewChat` can be left over from a cross-tab
                    // event, so it must not prevent a page-load restore.
                    if (!this.activeConversationId
                        && !this.hasStartedChat
                        && pageConversations[0]?.id) {
                        this.switchConversation(pageConversations[0].id, true);
                        return;
                    }
                    this.isHistoryLoading = false;
                    return;
                }

                const loadedIds = new Set(this.conversations.map(conversation => Number(conversation.id)));
                this.conversations = [
                    ...this.conversations,
                    ...pageConversations.filter(conversation => !loadedIds.has(Number(conversation.id)))
                ];
            },

            loadMoreConversations() {
                if (!this.hasMoreConversations || !this.nextConversationPage || this.isLoadingMoreConversations) return;
                this.loadConversations(this.nextConversationPage, true);
            },

            handleConversationHistoryScroll(event) {
                const container = event.currentTarget;
                if (!container || container.scrollTop + container.clientHeight < container.scrollHeight - 72) return;
                this.loadMoreConversations();
            },

            prepareConversationTitleMarquee(event) {
                const row = event?.currentTarget;
                if (!row || typeof window.requestAnimationFrame !== 'function') return;

                window.requestAnimationFrame(() => {
                    const viewport = row.querySelector('.afd-ai-chat__sidebar-item-title');
                    const track = row.querySelector('.afd-ai-chat__sidebar-item-title-track');
                    if (!viewport || !track) return;

                    // Edit/Delete float above the title and must never resize
                    // it. Include their visual rail only in the marquee travel
                    // distance so the final characters stop before the icons.
                    const actionRail = row.querySelector('.afd-ai-chat__sidebar-item-actions');
                    const actionRailWidth = actionRail
                        ? Math.ceil(actionRail.getBoundingClientRect().width + 4)
                        : 0;
                    const readableWidth = Math.max(0, viewport.clientWidth - actionRailWidth);
                    const distance = Math.ceil(track.scrollWidth - readableWidth);
                    const canScroll = distance > 4;
                    row.classList.toggle('afd-ai-chat__sidebar-item-wrap--title-overflow', canScroll);

                    if (!canScroll) {
                        row.style.removeProperty('--afd-ai-chat-title-scroll-offset');
                        row.style.removeProperty('--afd-ai-chat-title-scroll-duration');
                        return;
                    }

                    const duration = Math.max(2.4, Math.min(6, distance / 18));
                    row.style.setProperty('--afd-ai-chat-title-scroll-offset', `-${distance}px`);
                    row.style.setProperty('--afd-ai-chat-title-scroll-duration', `${duration}s`);
                });
            },

            createHistoryLoadToken() {
                this.historyLoadSequence = (Number(this.historyLoadSequence) || 0) + 1;
                return `${Date.now()}-${this.historyLoadSequence}`;
            },

            isCurrentConversationResponse(data = {}) {
                const responseConversationId = Number(data.conversationId || data.conversation_id) || 0;
                if (responseConversationId && responseConversationId !== Number(this.activeConversationId)) {
                    return false;
                }

                const responseToken = String(data.client_load_token || data.load_token || '');
                return !responseToken || responseToken === String(this.activeHistoryLoadToken || '');
            },

            switchConversation(conversationId, forceReload = false, options = {}) {
                const targetConversationId = Number(conversationId) || 0;
                if (!targetConversationId) return;
                if (!forceReload && Number(this.activeConversationId) === targetConversationId && this.hasStartedChat) return;

                const isCurrentConversation = Number(this.activeConversationId) === targetConversationId;
                const preserveVisibleMessages = options.preserveVisibleMessages === true
                    && isCurrentConversation
                    && Array.isArray(this.messages)
                    && this.messages.length > 0;
                const loadToken = this.createHistoryLoadToken();
                this.activeHistoryLoadToken = loadToken;

                if (!preserveVisibleMessages) {
                    this.stopSupportTyping?.();
                    this.setSupportRemoteTyping?.(false);
                    this.closeMobileSidebar();
                    this.stopCurrentResponse();
                    this.cancelEditMessage();
                    this.cancelConversationRename();
                    this.humanSupportActive = false;
                    this.humanSupportAgentLabel = '';
                    this.supportConversationClosed = false;
                    this.messages = [];
                    this.hasStartedChat = false;
                    this.hasOlderMessages = false;
                    this.nextMessageCursor = null;
                    this.isLoadingOlderMessages = false;
                    this.historyScrollHeightBeforeLoad = 0;
                    this.currentAiMessageIndex = -1;
                }

                this.activeConversationId = targetConversationId;
                this.isLoading = !preserveVisibleMessages;
                // An explicit conversation change needs the loading cover.
                // A passive refresh preserves the current visual state: it
                // must neither introduce a cover during tab sync nor dismiss
                // the initial cover before the durable history is loaded.
                if (!preserveVisibleMessages) {
                    this.isHistoryLoading = true;
                    this.armHistoryLoadingTimeout?.();
                }
                this.isCreatingNewChat = false;

                const request = {
                    action: 'load_conversation',
                    conversation_id: targetConversationId,
                    client_load_token: loadToken,
                    // A passive rehydration merges durable data into the
                    // visible conversation instead of replacing it.
                    refresh: preserveVisibleMessages
                };
                if (this.socket && this.wsConnected) {
                    this.socket.send(JSON.stringify(request));
                } else {
                    fetch(urls.loadConversation + '?id=' + targetConversationId).then(r=>r.json()).then(data => {
                        const response = {
                            ...data,
                            conversationId: targetConversationId,
                            client_load_token: loadToken,
                            refresh: preserveVisibleMessages || data.refresh === true
                        };
                        if (!this.isCurrentConversationResponse(response)) return;
                        this.isLoading = false;
                        this.applyConversationMessagePage(response, false);
                    }).catch(() => {
                        if (loadToken !== this.activeHistoryLoadToken) return;
                        this.isLoading = false;
                        this.isHistoryLoading = false;
                    });
                }
            },

            refreshSupportConversation(conversationId = this.activeConversationId) {
                const targetId = Number(conversationId) || 0;
                if (!targetId || targetId !== Number(this.activeConversationId)) return;
                if (this.socket && this.wsConnected) {
                    this.socket.send(JSON.stringify({
                        action: 'load_conversation',
                        conversation_id: targetId,
                        refresh: true
                    }));
                    return;
                }

                fetch(urls.loadConversation + '?id=' + targetId)
                    .then(response => response.json())
                    .then(data => this.applyConversationMessagePage({ ...data, refresh: true }, false))
                    .catch(() => {});
            },

            applyConversationMessagePage(data, append) {
                if (!this.isCurrentConversationResponse(data)) {
                    if (append) {
                        this.isLoadingOlderMessages = false;
                        this.historyScrollHeightBeforeLoad = 0;
                    }
                    return false;
                }
                this.isLoadingOlderMessages = false;
                if (data.status !== 'success') {
                    this.isHistoryLoading = false;
                    return;
                }

                const pageMessages = Array.isArray(data.messages)
                    ? data.messages.map(message => this.normalizeLoadedMessage(message))
                    : [];
                this.hasOlderMessages = data.has_more === true;
                this.nextMessageCursor = Number(data.next_before_message_id) || null;

                if (data.refresh === true) {
                    const existingIndexesByEntityId = new Map();
                    const transientIndexesByFingerprint = new Map();
                    this.messages.forEach((message, index) => {
                        const entityId = Number(message?.entity_id) || 0;
                        if (entityId) {
                            const indexes = existingIndexesByEntityId.get(entityId) || [];
                            indexes.push(index);
                            existingIndexesByEntityId.set(entityId, indexes);
                            return;
                        }
                        const fingerprint = messageHydrationFingerprint(message);
                        const indexes = transientIndexesByFingerprint.get(fingerprint) || [];
                        indexes.push(index);
                        transientIndexesByFingerprint.set(fingerprint, indexes);
                    });

                    // A guest page can be restored from sessionStorage while
                    // a former refresh is also represented in that snapshot.
                    // Keep one canonical slot for every durable message and
                    // discard *all* equivalent snapshot copies. A Map from
                    // entity id to one index is insufficient here: it leaves
                    // an earlier duplicate untouched when two existing
                    // entries carry the same entity id.
                    const usedExistingIndexes = new Set();
                    const replacementByIndex = new Map();
                    const indexesToRemove = new Set();
                    const additions = [];
                    pageMessages.forEach((message) => {
                        const entityId = Number(message?.entity_id) || 0;
                        const fingerprint = messageHydrationFingerprint(message);
                        const matchingIndexes = [
                            ...(entityId ? (existingIndexesByEntityId.get(entityId) || []) : []),
                            ...(transientIndexesByFingerprint.get(fingerprint) || [])
                        ]
                            .filter((index, position, indexes) => indexes.indexOf(index) === position)
                            .filter(index => !usedExistingIndexes.has(index) && !indexesToRemove.has(index))
                            .sort((left, right) => left - right);
                        const canonicalIndex = matchingIndexes.shift();

                        if (canonicalIndex === undefined) {
                            additions.push(message);
                            return;
                        }

                        usedExistingIndexes.add(canonicalIndex);
                        replacementByIndex.set(canonicalIndex, {
                            ...this.messages[canonicalIndex],
                            ...message
                        });
                        matchingIndexes.forEach((index) => {
                            usedExistingIndexes.add(index);
                            indexesToRemove.add(index);
                        });
                    });
                    this.messages = this.messages
                        .filter((message, index) => !indexesToRemove.has(index))
                        .map((message, index) => replacementByIndex.get(index) || message);
                    this.messages.push(...additions);
                    this.enforceSingleActiveOrderAddressForm();
                    this.hasStartedChat = this.messages.length > 0;
                    this.isHistoryLoading = false;
                    this.scheduleGuestSessionSnapshot();
                    this.$nextTick(() => this.scrollToBottom());
                    return;
                }

                if (append) {
                    this.messages = [...pageMessages, ...this.messages];
                    this.enforceSingleActiveOrderAddressForm();
                    this.$nextTick(() => {
                        const messageList = document.getElementById('chatWindow');
                        if (messageList) {
                            messageList.scrollTop = Math.max(
                                0,
                                messageList.scrollHeight - this.historyScrollHeightBeforeLoad
                            );
                        }
                        this.historyScrollHeightBeforeLoad = 0;
                    });
                    return;
                }

                this.messages = pageMessages;
                this.enforceSingleActiveOrderAddressForm();
                this.hasStartedChat = pageMessages.length > 0;
                this.isHistoryLoading = false;
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => this.scrollToBottom(true));
            },

            loadOlderMessages() {
                if (
                    !this.activeConversationId ||
                    !this.hasOlderMessages ||
                    !this.nextMessageCursor ||
                    this.isLoadingOlderMessages ||
                    this.isLoading
                ) {
                    return;
                }

                this.isLoadingOlderMessages = true;
                const beforeMessageId = this.nextMessageCursor;
                const messageList = document.getElementById('chatWindow');
                this.historyScrollHeightBeforeLoad = messageList ? messageList.scrollHeight : 0;

                if (this.socket && this.wsConnected) {
                    this.socket.send(JSON.stringify({
                        action: 'load_conversation',
                        conversation_id: this.activeConversationId,
                        before_message_id: beforeMessageId
                    }));
                    return;
                }

                const baseUrl = urls.loadConversation;
                fetch(baseUrl + '?id=' + this.activeConversationId + '&before_message_id=' + beforeMessageId)
                    .then(response => response.json())
                    .then(data => this.applyConversationMessagePage(data, true))
                    .catch(() => {
                        this.isLoadingOlderMessages = false;
                        this.historyScrollHeightBeforeLoad = 0;
                    });
            },

            openConversationDeleteDialog(conversation, event = null) {
                if (!conversation?.id) return;
                this.cancelConversationRename();
                const conversationId = conversation.id;
                const isSupportTicket = conversation.type === 'support';
                this.openConfirmationDialog({
                    kicker: isSupportTicket ? 'Support ticket' : 'Conversation',
                    title: isSupportTicket ? 'Close this ticket?' : 'Delete this chat?',
                    description: isSupportTicket
                        ? 'The ticket will become read-only and disappear from chat history. Its messages remain safely stored.'
                        : 'This conversation and its messages will be permanently removed.',
                    preview: String(conversation.title || 'Untitled conversation').trim(),
                    icon: isSupportTicket ? 'lock' : 'delete',
                    confirmLabel: isSupportTicket ? 'Close ticket' : 'Delete',
                    confirmIcon: isSupportTicket ? 'lock' : 'delete',
                    variant: 'danger',
                    action: () => this.deleteConversation(conversationId)
                }, event);
            },

            openConfirmationDialog(options = {}, event = null) {
                const defaults = {
                    kicker: 'Confirmation',
                    title: 'Are you sure?',
                    description: '',
                    preview: '',
                    icon: 'help',
                    confirmLabel: 'Confirm',
                    confirmIcon: 'check',
                    variant: 'accent'
                };
                this.confirmationDialog = { ...defaults, ...options };
                this.confirmationDialogAction = typeof options.action === 'function' ? options.action : null;
                this.confirmationDialogReturnFocus = event?.currentTarget instanceof HTMLElement
                    ? event.currentTarget
                    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
                // Native keyboard activation emits click detail 0. Pointer
                // activation emits a positive detail and must not leave the
                // hidden action rail visible after the modal closes.
                this.confirmationDialogShouldRestoreFocus = !event || event.detail === 0;
                this.isConfirmationDialogOpen = true;
                this.$nextTick(() => this.$refs.confirmationDialogCancel?.focus());
            },

            closeConfirmationDialog(restoreFocus = true) {
                if (!this.isConfirmationDialogOpen) return;
                const returnFocus = this.confirmationDialogReturnFocus;
                const shouldRestoreFocus = this.confirmationDialogShouldRestoreFocus;
                this.isConfirmationDialogOpen = false;
                this.confirmationDialogAction = null;
                this.confirmationDialogReturnFocus = null;
                this.confirmationDialogShouldRestoreFocus = false;
                if (restoreFocus && shouldRestoreFocus && returnFocus?.isConnected) {
                    this.$nextTick(() => returnFocus.focus());
                } else {
                    this.$nextTick(() => {
                        if (document.activeElement?.closest('.afd-ai-chat__confirm-dialog')) {
                            document.activeElement.blur();
                        }
                    });
                }
            },

            trapConfirmationDialogFocus(event) {
                const controls = [
                    this.$refs.confirmationDialogCancel,
                    this.$refs.confirmationDialogConfirm
                ].filter(control => control && !control.disabled);
                if (!controls.length) return;

                const currentIndex = controls.indexOf(document.activeElement);
                const direction = event.shiftKey ? -1 : 1;
                const nextIndex = currentIndex < 0
                    ? 0
                    : (currentIndex + direction + controls.length) % controls.length;
                controls[nextIndex].focus();
            },

            confirmDialogAction() {
                const action = this.confirmationDialogAction;
                this.closeConfirmationDialog(false);
                if (typeof action === 'function') action();
            },

            async deleteConversation(conversationId) {
                const targetId = Number(conversationId) || 0;
                if (!targetId || this.pendingConversationDeleteId) return;
                this.pendingConversationDeleteId = targetId;

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'delete_conversation',
                            conversation_id: targetId
                        }));
                        return;
                    } catch (error) {
                        this.wsConnected = false;
                    }
                }

                try {
                    const response = await fetch(urls.deleteConversation, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-Form-Key': getBrowserFormKey()
                        },
                        body: JSON.stringify({ conversation_id: targetId })
                    });
                    const result = await response.json();
                    this.applyConversationDeleteResult(targetId, result.status === 'success', result.message || '');
                } catch (error) {
                    this.applyConversationDeleteResult(targetId, false, error.message || '');
                }
            },

            applyConversationDeleteResult(conversationId, succeeded, message = '') {
                const targetId = Number(conversationId) || Number(this.pendingConversationDeleteId) || 0;
                this.pendingConversationDeleteId = null;
                if (!succeeded) {
                    this.setTransportNotice(
                        'conversation-delete-failed',
                        'Conversation not deleted',
                        message || 'The conversation could not be deleted. Please try again.'
                    );
                    this.loadConversations();
                    return;
                }

                this.conversations = this.conversations.filter(conversation => Number(conversation.id) !== targetId);
                if (this.editingConversationId === targetId) this.cancelConversationRename();
                if (Number(this.activeConversationId) === targetId) {
                    // Confirmation already happened in the shared modal.
                    this.performStartNewChat(false);
                }
                this.loadConversations();
            },

            getRenameConversationInput() {
                const input = this.$refs.renameConversationInput;
                if (Array.isArray(input)) return input[0] || null;
                return input || null;
            },

            beginConversationRename(conversation) {
                if (!conversation || !conversation.id) return;
                this.cancelEditMessage();
                this.editingConversationId = conversation.id;
                this.editingConversationDraft = conversation.title || '';
                this.$nextTick(() => {
                    const input = this.getRenameConversationInput();
                    if (input) {
                        input.focus();
                        input.select();
                    }
                });
            },

            cancelConversationRename() {
                this.editingConversationId = null;
                this.editingConversationDraft = '';
            },

            applyConversationTitle(conversationId, title) {
                const cleanTitle = String(title || '').trim();
                if (!conversationId || !cleanTitle) return;
                this.conversations = this.conversations.map(conversation => (
                    Number(conversation.id) === Number(conversationId)
                        ? { ...conversation, title: cleanTitle }
                        : conversation
                ));
            },

            async submitConversationRename(conversationId) {
                const title = this.editingConversationDraft.trim().slice(0, 255);
                if (!conversationId || !title) return;

                const current = this.conversations.find(conversation => Number(conversation.id) === Number(conversationId));
                if (current && String(current.title || '').trim() === title) {
                    this.cancelConversationRename();
                    return;
                }

                this.applyConversationTitle(conversationId, title);

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'rename_conversation',
                            conversation_id: conversationId,
                            title
                        }));
                        return;
                    } catch (e) {
                        this.wsConnected = false;
                    }
                }

                const formKey = getBrowserFormKey();
                try {
                    const response = await fetch(urls.updateConversationTitle, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-Form-Key': formKey
                        },
                        body: JSON.stringify({ conversation_id: conversationId, title })
                    });
                    const data = await response.json();
                    if (data.status !== 'success') {
                        throw new Error(data.message || 'The conversation title could not be updated.');
                    }
                    this.applyConversationTitle(conversationId, data.title || title);
                    this.cancelConversationRename();
                    this.loadConversationsHTTP();
                } catch (e) {
                    if (current) this.applyConversationTitle(conversationId, current.title || '');
                    this.setTransportNotice('conversation-rename-failed', 'Rename failed', e.message || 'The conversation title could not be updated.');
                }
            },

            // HTTP Fallbacks
            loadConversationsHTTP(page = 1, append = false) {
                const url = urls.conversations + '?page=' + Math.max(1, Number(page) || 1);
                fetch(url).then(r=>r.json()).then(data => {
                    if (data.status === 'success') {
                        this.applyConversationPage({ ...data, append });
                    }
                }).catch(e => {
                    this.isLoadingMoreConversations = false;
                    this.isHistoryLoading = false;
                    console.error('[Afd_AI] Error:', e);
                    this.setTransportNotice('conversation-load-failed', 'Conversation list unavailable', 'The sidebar history could not be loaded.');
                });
            },

            loadHistoryHTTP() {
                fetch(urls.history).then(r=>r.json()).then(data => {
                    if (data.status === 'success' && data.messages.length > 0) {
                        this.cancelEditMessage();
                        this.hasStartedChat = true;
                        this.messages = data.messages.map(m => this.normalizeLoadedMessage(m));
                        this.enforceSingleActiveOrderAddressForm();
                        this.$nextTick(() => this.scrollToBottom(true));
                    }
                }).catch(e => {
                    console.error('[Afd_AI] Error:', e);
                    this.setTransportNotice('history-load-failed', 'Chat history unavailable', 'Previous messages could not be restored.');
                });
            },

            // ==================== CHAT ACTIONS ====================

            openHistorySearch() {
                this.closeMobileSidebar();
                this.closeSettings();
                this.cancelConversationRename();
                this.historySearchQuery = '';
                this.historySearchFilter = 'all';
                this.isHistorySearchOpen = true;
                if (this.hasConversationHistory) this.loadConversations();
                this.$nextTick(() => {
                    const input = this.$refs.historySearchInput;
                    if (input) input.focus();
                });
            },

            closeHistorySearch(restoreFocus = true) {
                this.isHistorySearchOpen = false;
                this.historySearchQuery = '';
                this.historySearchFilter = 'all';
                if (!restoreFocus) return;
                this.$nextTick(() => {
                    const trigger = this.$refs.historySearchTrigger;
                    if (trigger) trigger.focus();
                });
            },

            getHistorySearchResults() {
                const query = String(this.historySearchQuery || '').trim().toLocaleLowerCase();
                const conversations = Array.isArray(this.conversations) ? this.conversations : [];
                if (!query) return conversations;

                return conversations.filter((conversation) => (
                    String(conversation?.title || '').toLocaleLowerCase().includes(query)
                ));
            },

            clearHistorySearch() {
                this.historySearchQuery = '';
                this.historySearchFilter = 'all';
                this.$nextTick(() => this.$refs.historySearchInput?.focus());
            },

            setHistorySearchFilter(filter) {
                this.historySearchFilter = filter;
            },

            shouldShowHistorySearchConversations() {
                return !String(this.historySearchQuery || '').trim()
                    || this.historySearchFilter === 'all'
                    || this.historySearchFilter === 'chats';
            },

            selectHistorySearchConversation(conversationId) {
                if (!conversationId) return;
                this.closeHistorySearch(false);
                this.switchConversation(conversationId);
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
