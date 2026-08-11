/** Initial state grouped by concern while preserving Alpine's public flat API. */
(function (modules) {
    'use strict';

    modules.createInitialState = function (config) {
        return Object.assign(
            shellState(),
            transportState(),
            supportState(),
            windowState(),
            attachmentState(),
            dialogState(),
            historyState(config)
        );
    };

    function shellState() {
        return {
            isOpen: false,
            isSettingsOpen: false,
            isHistorySearchOpen: false,
            historySearchQuery: '',
            historySearchFilter: 'all',
            showBubble: true,
            userInput: '',
            messages: [],
            isLoading: false,
            isHistoryLoading: false,
            isAtChatBottom: true,
            hasUnreadMessages: false,
            hasStartedChat: false,
            currentAiMessageIndex: -1,
            pendingProductParts: [],
            pendingOrderAddressFormParts: [],
            pendingGuestOrderAccessParts: [],
            toolActivities: [],
            statusMessage: '',
            imageGenerationNow: Date.now(),
            imageGenerationTimer: null,
            isComposerExpanded: false,
            richTextAssetsPromise: null
        };
    }

    function transportState() {
        return {
            socket: null,
            socketConnectPromise: null,
            connectionAttempted: false,
            wsHasEverConnected: false,
            wsConnected: false,
            wsReconnectTimer: null,
            transportNotice: null,
            activeRequestId: null,
            responseStartedAt: 0,
            cancelledRequestIds: {},
            responseWatchdogTimer: null,
            chatSyncChannel: null,
            chatSyncTransport: '',
            chatSyncStorageKey: 'afd-ai-chat-sync-event-v1',
            chatSyncScope: '',
            chatSyncTabId: 'afd-ai-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
            chatSyncTimer: null,
            guestSessionSnapshotTimer: null,
            guestSessionSnapshotRestored: false,
            historyLoadSequence: 0,
            activeHistoryLoadToken: '',
            historyLoadingTimeout: null
        };
    }

    function supportState() {
        return {
            pendingSupportConversationId: 0,
            humanSupportActive: false,
            humanSupportAgentLabel: '',
            supportConversationClosed: false,
            supportRemoteTyping: false,
            supportRemoteTypingLabel: '',
            supportRemoteTypingTimer: null,
            supportTypingIdleTimer: null,
            supportTypingSent: false,
            supportTypingSentAt: 0,
            guestOrderAccessState: 'email',
            guestOrderAccessExpiresAt: 0,
            guestOrderAccessExpiryTimer: null
        };
    }

    function windowState() {
        return {
            launcherStorageKey: 'afd_ai_chat_launcher_position',
            launcherPosition: null,
            isDragging: false,
            dragStart: null,
            dragMoved: false,
            suppressLauncherClick: false,
            chatWindowStorageKey: 'afd_ai_chat_window_layout',
            chatWindowLayout: null,
            chatWindowInteraction: null,
            isWindowDragging: false,
            isWindowResizing: false,
            isMobileSidebarOpen: false,
            chatWindowWidth: 0,
            chatWindowResizeObserver: null,
            petHovering: false,
            petState: 'idle',
            petDragState: null,
            petAnimationTimer: null,
            petReducedMotion: typeof window.matchMedia === 'function'
                ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
                : false,
            uiSettingsStorageKey: 'afd_ai_chat_ui_settings',
            uiSettings: {
                theme: 'light',
                accent: '#004272',
                glassOpacity: 55,
                fontSize: 'medium',
                density: 'compact',
                petMotion: true
            }
        };
    }

    function attachmentState() {
        return {
            canUploadImages: true,
            imageAttachments: [],
            isReadingAttachments: false,
            uploadError: '',
            isImageViewerOpen: false,
            imageViewerAttachments: [],
            imageViewerIndex: 0,
            editingMessageIndex: null,
            editingMessageDraft: '',
            editingMessageAttachments: [],
            productPageLoading: {}
        };
    }

    function dialogState() {
        return {
            editingConversationId: null,
            editingConversationDraft: '',
            isConfirmationDialogOpen: false,
            confirmationDialog: {
                kicker: '',
                title: '',
                description: '',
                preview: '',
                icon: 'help',
                confirmLabel: 'Confirm',
                confirmIcon: 'check',
                variant: 'accent'
            },
            confirmationDialogAction: null,
            confirmationDialogReturnFocus: null,
            confirmationDialogShouldRestoreFocus: false,
            pendingConversationDeleteId: null,
            copiedMessageIndex: null,
            copyResetTimer: null,
            messageFeedback: {},
            privacyBusy: false,
            privacyDeleteArmed: false,
            privacyNotice: '',
            privacyNoticeVariant: 'neutral'
        };
    }

    function historyState(config) {
        return {
            isLoggedIn: config.isLoggedIn === true,
            hasConversationHistory: config.isLoggedIn === true,
            customerId: Number(config.customerId) || 0,
            conversations: [],
            activeConversationId: null,
            isCreatingNewChat: false,
            conversationPage: 1,
            hasMoreConversations: false,
            nextConversationPage: null,
            isLoadingMoreConversations: false,
            hasOlderMessages: false,
            nextMessageCursor: null,
            isLoadingOlderMessages: false,
            historyScrollHeightBeforeLoad: 0
        };
    }
}(window.AfdAiChat = window.AfdAiChat || {}));
