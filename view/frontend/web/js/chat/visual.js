/** visualMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.visualMethods = function (context) {
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
        const PET_SPRITESHEET_URL = String(config.petSpritesheetUrl || '');

        return {
            currentImageViewerAttachment() {
                return this.imageViewerAttachments[this.imageViewerIndex] || {
                    name: 'Image',
                    previewUrl: ''
                };
            },

            openImageViewer(attachments, selectedIndex = 0) {
                const images = (Array.isArray(attachments) ? attachments : [])
                    .filter(attachment => attachment && String(attachment.previewUrl || '').trim())
                    .map(attachment => ({
                        name: String(attachment.name || 'Image'),
                        previewUrl: String(attachment.previewUrl)
                    }));
                if (!images.length) return;

                this.imageViewerAttachments = images;
                this.imageViewerIndex = Math.max(0, Math.min(Number(selectedIndex) || 0, images.length - 1));
                this.isImageViewerOpen = true;
                this.$nextTick(() => {
                    const closeButton = Array.isArray(this.$refs.imageViewerClose)
                        ? this.$refs.imageViewerClose[0]
                        : this.$refs.imageViewerClose;
                    if (closeButton) closeButton.focus();
                });
            },

            closeImageViewer() {
                this.isImageViewerOpen = false;
                this.imageViewerAttachments = [];
                this.imageViewerIndex = 0;
            },

            normalizeLoadedMessage(message) {
                if (message.role !== 'assistant' && message.role !== 'model') {
                    const attachmentCandidates = Array.isArray(message.attachments)
                        ? message.attachments
                        : (message.attachment && typeof message.attachment === 'object' ? [message.attachment] : []);
                    const attachments = attachmentCandidates
                        .map((attachment) => {
                            if (!attachment || typeof attachment !== 'object') return null;
                            const type = String(attachment.type || attachment.mime_type || 'image/jpeg');
                            const attachmentId = attachment.attachment_id || null;
                            let previewUrl = String(attachment.previewUrl || attachment.url || '');
                            if (attachmentId && (!previewUrl || previewUrl.startsWith('blob:'))) {
                                previewUrl = `/afd_ai/chat/attachment?id=${encodeURIComponent(attachmentId)}`;
                            }
                            if ((!previewUrl || previewUrl.startsWith('blob:')) && (attachment.data || attachment.base64)) {
                                previewUrl = `data:${type};base64,${attachment.data || attachment.base64}`;
                            }
                            if (!previewUrl || previewUrl.startsWith('blob:')) return null;
                            return {
                                name: String(attachment.name || 'image'),
                                size: Number(attachment.size) || 0,
                                type,
                                attachment_id: attachmentId,
                                previewUrl
                            };
                        })
                        .filter(Boolean);

                    return {
                        entity_id: Number(message.entity_id) || null,
                        role: 'user',
                        content: message.is_deleted === true ? '' : (message.content || ''),
                        attachments: message.is_deleted === true ? [] : attachments,
                        edited: message.is_edited === true,
                        editedAt: String(message.edited_at || ''),
                        deleted: message.is_deleted === true,
                        deletedAt: String(message.deleted_at || ''),
                        mutationBusy: false
                    };
                }

                const sourceParts = Array.isArray(message.parts) && message.parts.length > 0
                    ? message.parts
                    : [{ type: 'text', raw: message.content || '' }];
                const lastProductIndex = sourceParts.reduce(
                    (last, part, index) => part?.type === 'products' ? index : last,
                    -1
                );
                // Compatibility for conversations persisted by older gateways:
                // internal search attempts must not reappear as multiple grids.
                const displayParts = sourceParts.filter(
                    (part, index) => part?.type !== 'products' || index === lastProductIndex
                );

                return {
                    entity_id: Number(message.entity_id) || null,
                    role: 'assistant',
                    source: message.source === 'support_agent' ? 'support_agent' : '',
                    senderLabel: message.source === 'support_agent'
                        ? String(message.sender_label || 'Support team').slice(0, 80)
                        : '',
                    feedbackEnabled: message.is_deleted !== true
                        && message.source !== 'support_agent'
                        && Boolean(Number(message.entity_id)),
                    feedback: ['positive', 'negative'].includes(String(message.feedback || '')) ? String(message.feedback) : null,
                    feedbackReason: String(message.feedback_reason || ''),
                    feedbackComment: String(message.feedback_comment || ''),
                    feedbackDetailsSaved: Boolean(message.feedback_reason || message.feedback_comment),
                    feedbackBusy: false,
                    interrupted: message.interrupted === true,
                    stoppedAfterSeconds: Math.max(
                        0,
                        Number(message.stopped_after_seconds ?? message.stoppedAfterSeconds) || 0
                    ),
                    edited: message.is_edited === true,
                    editedAt: String(message.edited_at || ''),
                    deleted: message.is_deleted === true,
                    deletedAt: String(message.deleted_at || ''),
                    mutationBusy: false,
                    parts: (message.is_deleted === true ? [] : displayParts).map((part, index) => {
                        const id = part.id || (Date.now() + Math.random() + index);

                        if (part.type === 'products') {
                            return {
                                id,
                                type: 'products',
                                html: hydrateProductGridHtml(part.html || ''),
                                payload: part.payload || null
                            };
                        }

                        if (part.type === 'image' && /^(?:https?:\/\/|\/media\/)/i.test(String(part.url || ''))) {
                            return {
                                id,
                                type: 'image',
                                status: 'complete',
                                url: String(part.url),
                                alt: String(part.alt || 'Generated image').slice(0, 400),
                                prompt: String(part.prompt || '').slice(0, 4000),
                                size: String(part.size || ''),
                                quality: String(part.quality || '')
                            };
                        }

                        if (part.type === 'guest_order_access') {
                            const expiresAt = this.normalizeGuestOrderAccessExpiry(part.expires_at ?? part.expiresAt);
                            const storedState = part.state === 'verified'
                                ? 'verified'
                                : (expiresAt > Date.now() ? 'email' : 'expired');
                            return {
                                id,
                                type: 'guest_order_access',
                                purpose: part.purpose === 'support' ? 'support' : 'order',
                                state: part.purpose === 'support'
                                    ? storedState
                                    : (this.guestOrderAccessState === 'verified' ? 'verified' : storedState),
                                expiresAt,
                                remainingSeconds: storedState === 'expired' ? 0 : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
                                expiryTimer: null,
                                email: '',
                                code: '',
                                notice: '',
                                noticeVariant: 'neutral',
                                busy: false,
                                portalLoading: false,
                                tickets: Array.isArray(part.tickets) ? part.tickets : [],
                                ticketFormOpen: false,
                                ticketSubject: '',
                                ticketMessage: '',
                                ticketCategory: 'general'
                            };
                        }

                        if (part.type === 'order_address_form') {
                            return this.createOrderAddressFormPart(part);
                        }

                        if (part.type === 'reasoning') {
                            return {
                                id,
                                type: 'reasoning',
                                events: Array.isArray(part.events) ? part.events : [],
                                steps: Array.isArray(part.steps) ? part.steps : [],
                                activities: Array.isArray(part.activities) ? part.activities : [],
                                isExpanded: Boolean(part.isExpanded)
                            };
                        }

                        const raw = sanitizeCustomerResponseText(part.raw || part.text || '');
                        return {
                            id,
                            type: 'text',
                            raw,
                            html: sanitizeHtml(raw)
                        };
                    })
                };
            },

            setTransportNotice(key, title, text, variant = 'warning') {
                if (typeof key === 'string' && key.indexOf('realtime-') === 0) {
                    return;
                }
                const currentKey = this.transportNotice && this.transportNotice.key ? this.transportNotice.key : null;
                if (currentKey === key && this.transportNotice && this.transportNotice.title === title && this.transportNotice.text === text) {
                    return;
                }
                this.transportNotice = {
                    key,
                    title,
                    text,
                    variant
                };
            },

            clearTransportNotice(key = null) {
                if (!this.transportNotice) return;
                if (key && this.transportNotice.key !== key) return;
                this.transportNotice = null;
            },

            petSpriteStyle() {
                return 'background-image: url("' + PET_SPRITESHEET_URL + '");';
            },

            resolvePetState() {
                if (this.isDragging) return this.petDragState || 'running';
                if (this.petHovering) return 'jumping';
                if (this.isLoading) return 'running';
                const status = (this.statusMessage || '').toLowerCase();
                if (status && /(lỗi|error|fail|thất bại|blocked)/i.test(status)) return 'failed';
                if (status && /(confirm|xác nhận|duyệt|approve|waiting|cần nhập|nhập)/i.test(status)) return 'waiting';
                if (this.isOpen) return 'review';
                if (this.hasStartedChat) return 'review';
                if (this.showBubble) return 'waving';
                return 'idle';
            },

            syncPetAnimation() {
                const sprite = this.$refs.petSprite;
                if (!sprite) return;

                const nextState = this.resolvePetState();
                if (this.petState !== nextState) {
                    this.petState = nextState;
                    this.stopPetAnimation();
                    this.playPetAnimation(sprite, nextState);
                    return;
                }

                if (!this.petAnimationTimer) {
                    this.playPetAnimation(sprite, nextState);
                }
            },

            stopPetAnimation() {
                if (this.petAnimationTimer) {
                    window.clearTimeout(this.petAnimationTimer);
                    this.petAnimationTimer = null;
                }
            },

            setPetDragState(nextState) {
                if (this.petDragState === nextState) return;
                this.petDragState = nextState;
                this.syncPetAnimation();
            },

            playPetAnimation(sprite, state) {
                const prefersReducedMotion = !this.uiSettings.petMotion || this.petReducedMotion || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
                const frames = PET_FRAME_LIBRARY[state] || PET_FRAME_LIBRARY.idle;
                const sequence = prefersReducedMotion
                    ? { frames: [frames[0]], loopStartIndex: null }
                    : (state === 'idle'
                        ? { frames, loopStartIndex: 0 }
                        : { frames: [...frames, ...frames, ...frames, ...PET_FRAME_LIBRARY.idle], loopStartIndex: frames.length * 3 });

                let index = 0;
                const applyFrame = () => {
                    const frame = sequence.frames[index];
                    if (!frame) return;
                    sprite.style.backgroundPosition = petFramePosition(frame);
                };

                applyFrame();
                if (sequence.frames.length <= 1) return;

                const advance = () => {
                    this.petAnimationTimer = window.setTimeout(() => {
                        index += 1;
                        if (index >= sequence.frames.length) {
                            if (sequence.loopStartIndex != null) {
                                index = sequence.loopStartIndex;
                                applyFrame();
                                advance();
                                return;
                            }
                            this.petAnimationTimer = null;
                            return;
                        }
                        applyFrame();
                        advance();
                    }, sequence.frames[index].frameDurationMs);
                };

                advance();
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
