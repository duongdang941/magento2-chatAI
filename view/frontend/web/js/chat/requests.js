/** requestMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.requestMethods = function (context) {
const { config, urls } = context;
const {
    sanitizeHtml,
    normalizeMarkdownForCopy,
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
            startNewChat(shouldBroadcast = true) {
                if (shouldBroadcast && !this.isLoggedIn) {
                    this.openConfirmationDialog({
                        kicker: 'New conversation',
                        title: 'Start a new chat?',
                        description: 'Your current guest chat history will be permanently deleted.',
                        icon: 'chat_add_on',
                        confirmLabel: 'Start new chat',
                        confirmIcon: 'add_comment',
                        variant: 'accent',
                        action: () => this.resetGuestHistory()
                    });
                    return;
                }
                this.performStartNewChat(shouldBroadcast);
            },

            resetGuestHistory() {
                if (this.socket && this.wsConnected) {
                    this.socket.send(JSON.stringify({ action: 'reset_guest_history' }));
                    return;
                }
                this.setTransportNotice(
                    'guest-history-reset-unavailable',
                    'Chat history could not be reset',
                    'The secure chat connection is unavailable. Please try again in a moment.'
                );
            },

            performStartNewChat(shouldBroadcast = true) {
                this.stopSupportTyping?.();
                this.setSupportRemoteTyping?.(false);
                this.closeMobileSidebar();
                this.stopCurrentResponse();
                this.cancelEditMessage();
                this.cancelConversationRename();
                this.messages = [];
                if (!this.isLoggedIn) this.clearGuestSessionSnapshot();
                this.hasStartedChat = false;
                this.hasOlderMessages = false;
                this.nextMessageCursor = null;
                this.isLoadingOlderMessages = false;
                this.historyScrollHeightBeforeLoad = 0;
                this.isHistoryLoading = false;
                this.isLoading = false;
                this.userInput = '';
                this.currentAiMessageIndex = -1;
                this.activeConversationId = null;
                // A support takeover belongs only to its ticket conversation.
                // New Chat must always return to an ordinary AI conversation.
                this.humanSupportActive = false;
                this.humanSupportAgentLabel = '';
                this.supportConversationClosed = false;
                this.pendingSupportConversationId = 0;
                this.isCreatingNewChat = true; // Flag to stay on Welcome screen
                this.statusMessage = '';
                this.messageFeedback = {};
                this.copiedMessageIndex = null;
                this.removeImageAttachment();
                this.$nextTick(() => this.resizeComposerInput());
                if (shouldBroadcast) {
                    this.broadcastCrossTabEvent('new_chat');
                    if (!this.isLoggedIn && this.socket && this.wsConnected) {
                        this.socket.send(JSON.stringify({ action: 'new_chat' }));
                    }
                }
            },

            sendSuggestion(text) {
                this.userInput = text;
                this.sendMessage();
            },

            messagePlainText(message) {
                if (!message) return '';
                if (message.role === 'user') return message.content || '';
                if (!Array.isArray(message.parts)) return '';

                return message.parts
                    .filter(part => part?.type === 'text')
                    .map(part => {
                        const raw = part.raw || this.htmlToText(part.html || '');
                        return normalizeMarkdownForCopy(raw);
                    })
                    .filter(Boolean)
                    .join('\n\n')
                    .trim();
            },

            htmlToText(html) {
                const container = document.createElement('div');
                container.innerHTML = html || '';
                return (container.textContent || container.innerText || '').trim();
            },

            attachmentBase64FromPreview(previewUrl) {
                const value = String(previewUrl || '');
                if (!value.includes(',')) return '';
                return value.split(',')[1] || '';
            },

            copyMessageAttachments(attachments) {
                return (Array.isArray(attachments) ? attachments : [])
                    .map((attachment) => {
                        const attachmentId = attachment?.attachment_id || null;
                        let previewUrl = String(attachment && attachment.previewUrl || attachment && attachment.url || '');
                        if (attachmentId && (!previewUrl || previewUrl.startsWith('blob:'))) {
                            previewUrl = `/afd_ai/chat/attachment?id=${encodeURIComponent(attachmentId)}`;
                        }
                        if (!previewUrl) return null;
                        return {
                            name: String(attachment.name || 'product-image'),
                            size: Number(attachment.size) || 0,
                            type: String(attachment.type || attachment.mime_type || 'image/jpeg').toLowerCase(),
                            attachment_id: attachmentId,
                            previewUrl
                        };
                    })
                    .filter(Boolean);
            },

            imageMimeType(attachment, dataUrl = '') {
                const declared = String(attachment && (attachment.type || attachment.mime_type) || '').toLowerCase();
                if (IMAGE_UPLOAD_TYPES.includes(declared)) return declared;

                const matched = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,/i);
                return matched && IMAGE_UPLOAD_TYPES.includes(matched[1].toLowerCase())
                    ? matched[1].toLowerCase()
                    : '';
            },

            readImageBlobAsDataUrl(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => reject(new Error('The original image could not be read.'));
                    reader.readAsDataURL(blob);
                });
            },

            async prepareAttachmentForResend(attachment) {
                const attachmentId = attachment?.attachment_id || null;
                let previewUrl = String(attachment && attachment.previewUrl || attachment && attachment.url || '');
                if (attachmentId && (!previewUrl || previewUrl.startsWith('blob:'))) {
                    previewUrl = `/afd_ai/chat/attachment?id=${encodeURIComponent(attachmentId)}`;
                }

                if (attachmentId) {
                    return {
                        name: String(attachment.name || 'product-image'),
                        size: Number(attachment.size) || 0,
                        type: String(attachment.type || attachment.mime_type || 'image/jpeg').toLowerCase(),
                        attachment_id: attachmentId,
                        previewUrl
                    };
                }

                if (!previewUrl) throw new Error('An original image is unavailable.');

                let dataUrl = previewUrl;
                let base64 = this.attachmentBase64FromPreview(dataUrl);
                let mimeType = this.imageMimeType(attachment, dataUrl);
                let size = Number(attachment && attachment.size) || 0;

                if (!base64) {
                    let imageUrl;
                    let response;
                    if (previewUrl.startsWith('blob:')) {
                        try {
                            response = await fetch(previewUrl);
                        } catch (e) {
                            // blob might be revoked
                        }
                    }
                    if (!response) {
                        try {
                            imageUrl = new URL(previewUrl, window.location.origin);
                        } catch (e) {
                            throw new Error('The original image URL is invalid.');
                        }
                        if (!/^https?:$/.test(imageUrl.protocol) || imageUrl.origin !== window.location.origin) {
                            throw new Error('The original image is not available from this store.');
                        }

                        response = await fetch(imageUrl.toString(), {
                            credentials: 'same-origin',
                            cache: 'force-cache'
                        });
                    }
                    if (!response || !response.ok) throw new Error('The original image could not be loaded.');

                    const blob = await response.blob();
                    if (blob.size > IMAGE_UPLOAD_MAX_BYTES) {
                        throw new Error('The original image is larger than 4MB and cannot be sent again.');
                    }
                    dataUrl = await this.readImageBlobAsDataUrl(blob);
                    base64 = this.attachmentBase64FromPreview(dataUrl);
                    mimeType = this.imageMimeType({ type: blob.type || mimeType }, dataUrl);
                    size = blob.size;
                }

                if (!base64 || !mimeType) throw new Error('The original image format is not supported.');
                return {
                    name: String(attachment.name || 'product-image'),
                    size,
                    type: mimeType,
                    previewUrl,
                    base64
                };
            },

            async prepareAttachmentsForResend(attachments) {
                const source = this.copyMessageAttachments(attachments);
                if (!source.length) return [];

                this.isReadingAttachments = true;
                try {
                    return await Promise.all(source.map(attachment => this.prepareAttachmentForResend(attachment)));
                } finally {
                    this.isReadingAttachments = false;
                }
            },

            async copyTextToClipboard(text) {
                const value = String(text || '');
                if (!value) return false;

                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    try {
                        await navigator.clipboard.writeText(value);
                        return true;
                    } catch (error) {
                        // Fall through to the selection-based path when the
                        // browser rejects a clipboard permission request.
                    }
                }

                const textarea = document.createElement('textarea');
                textarea.value = value;
                textarea.setAttribute('readonly', 'readonly');
                textarea.style.position = 'fixed';
                textarea.style.top = '0';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                let copied = false;
                try {
                    copied = typeof document.execCommand === 'function'
                        && document.execCommand('copy');
                } finally {
                    textarea.remove();
                }
                if (!copied) throw new Error('Clipboard access was denied.');
                return true;
            },

            async copyMessage(message, index) {
                const text = this.messagePlainText(message);
                if (!text) return;

                try {
                    await this.copyTextToClipboard(text);
                    this.copiedMessageIndex = index;
                    if (this.copyResetTimer) window.clearTimeout(this.copyResetTimer);
                    this.copyResetTimer = window.setTimeout(() => {
                        this.copiedMessageIndex = null;
                        this.copyResetTimer = null;
                    }, 1400);
                } catch (e) {
                    this.setTransportNotice('copy-failed', 'Copy failed', 'This browser did not allow copying the message.');
                }
            },

            async handleAssistantBubbleClick(event) {
                const button = event.target.closest('[data-code-copy]');
                if (!button) return;

                const block = button.closest('.afd-ai-chat__code-block');
                const code = block ? block.querySelector('code') : null;
                const text = code ? code.textContent || '' : '';
                if (!text) return;

                try {
                    await this.copyTextToClipboard(text);

                    button.classList.add('afd-ai-chat__code-copy--copied');
                    button.setAttribute('aria-label', 'Copied');
                    button.setAttribute('title', 'Copied');
                    const icon = button.querySelector('.material-symbols-outlined');
                    if (icon) icon.textContent = 'check';
                    window.setTimeout(() => {
                        button.classList.remove('afd-ai-chat__code-copy--copied');
                        button.setAttribute('aria-label', 'Copy code');
                        button.setAttribute('title', 'Copy code');
                        if (icon) icon.textContent = 'content_copy';
                    }, 1400);
                } catch (e) {
                    this.setTransportNotice('copy-code-failed', 'Copy failed', 'This browser did not allow copying the code.');
                }
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
