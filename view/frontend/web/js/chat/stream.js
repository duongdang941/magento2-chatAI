/** streamMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.streamMethods = function (context) {
const { config, urls } = context;
const {
    sanitizeHtml,
    escapeHtml,
    sanitizeCustomerResponseText,
    sanitizeStreamingHtml,
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
    MAX_WEBSOCKET_PAYLOAD_BYTES,
    MAX_MODEL_HISTORY_MESSAGES
} = context.helpers;

        const utf8ByteLength = value => {
            const source = String(value || '');
            if (typeof TextEncoder === 'function') {
                return new TextEncoder().encode(source).byteLength;
            }
            return unescape(encodeURIComponent(source)).length;
        };

        /**
         * A catalogue page is rendered by Magento as a complete grid.  The
         * chat, however, represents one search as one result set, so later
         * pages must contribute cards to the original grid rather than create
         * another grid below it.
         */
        const mergeProductGridHtml = (existingHtml, nextHtml) => {
            const existing = document.createElement('div');
            const incoming = document.createElement('div');
            existing.innerHTML = String(existingHtml || '');
            incoming.innerHTML = String(nextHtml || '');

            const existingGrid = existing.querySelector('.afd-ai-chat__product-grid');
            const incomingGrid = incoming.querySelector('.afd-ai-chat__product-grid');
            if (!existingGrid || !incomingGrid) {
                return `${existing.innerHTML}${incoming.innerHTML}`;
            }

            Array.from(incomingGrid.children).forEach((card) => {
                existingGrid.appendChild(card);
            });
            return existing.innerHTML;
        };

        const mergeProductPayload = (existingPayload, incomingPayload) => {
            const existing = existingPayload && typeof existingPayload === 'object' ? existingPayload : {};
            const incoming = incomingPayload && typeof incomingPayload === 'object' ? incomingPayload : {};
            const seen = new Set();
            const items = [];

            [...(Array.isArray(existing.items) ? existing.items : []), ...(Array.isArray(incoming.items) ? incoming.items : [])]
                .forEach((item) => {
                    const id = Number(item?.id || 0);
                    if (id > 0 && !seen.has(id)) {
                        seen.add(id);
                        items.push(item);
                    }
                });

            const total = Number(incoming.pagination?.total ?? incoming.total
                ?? existing.pagination?.total ?? existing.total ?? items.length);
            const safeTotal = Number.isFinite(total) ? Math.max(items.length, total) : items.length;

            return {
                ...existing,
                ...incoming,
                product_ids: Array.from(seen),
                items,
                coverage: {
                    shown: items.length,
                    total: safeTotal,
                    remaining: Math.max(0, safeTotal - items.length),
                    complete: items.length >= safeTotal
                },
                pagination: {
                    ...(existing.pagination || {}),
                    ...(incoming.pagination || {})
                },
                scope: {
                    ...(existing.scope || {}),
                    ...(incoming.scope || {})
                }
            };
        };

        const postFeedback = async (payload) => {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = window.setTimeout(() => controller?.abort(), 10000);

            try {
                const response = await fetch(urls.feedback, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Form-Key': getBrowserFormKey()
                    },
                    body: JSON.stringify(payload),
                    ...(controller ? { signal: controller.signal } : {})
                });
                let result = null;
                try {
                    result = await response.json();
                } catch (error) {
                    throw new Error('The feedback service returned an invalid response.');
                }
                if (!response.ok || result?.status !== 'success') {
                    throw new Error(result?.message || 'The rating could not be saved.');
                }
                return result;
            } catch (error) {
                if (controller?.signal.aborted) {
                    throw new Error('The feedback request timed out. Please try again.');
                }
                throw error;
            } finally {
                window.clearTimeout(timeoutId);
            }
        };

        return {
            createGuestOrderAccessPart(data = {}) {
                const expiresAt = this.normalizeGuestOrderAccessExpiry(data.expires_at ?? data.expiresAt);
                const requestedState = data.state === 'verified' ? 'verified' : 'email';
                const state = requestedState === 'verified'
                    ? 'verified'
                    : (expiresAt > Date.now() ? 'email' : 'expired');
                return {
                    id: String(data.form_id || data.formId || ('guest-order-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
                    type: 'guest_order_access',
                    purpose: data.purpose === 'support' ? 'support' : 'order',
                    state: data.purpose === 'support'
                        ? state
                        : (this.guestOrderAccessState === 'verified' ? 'verified' : state),
                    expiresAt,
                    remainingSeconds: state === 'expired' ? 0 : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
                    expiryTimer: null,
                    email: '',
                    code: '',
                    notice: '',
                    noticeVariant: 'neutral',
                    busy: false,
                    portalLoading: false,
                    tickets: Array.isArray(data.tickets) ? data.tickets : [],
                    ticketFormOpen: false,
                    ticketSubject: '',
                    ticketMessage: '',
                    ticketCategory: 'general'
                };
            },

            findGuestOrderAccessPart(formId) {
                const id = String(formId || '');
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'guest_order_access' && String(candidate.id) === id);
                    if (part) return part;
                }
                return null;
            },

            findPendingGuestOrderAccessPart() {
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'guest_order_access'
                        && candidate.state !== 'verified'
                        && candidate.state !== 'expired');
                    if (part) return part;
                }
                return null;
            },

            findLatestSupportAccessPart() {
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'guest_order_access' && candidate.purpose === 'support');
                    if (part) return part;
                }
                return null;
            },

            appendGuestOrderAccessForm(data = {}) {
                // The gateway persists one assistant turn per order request.
                // Keep the live projection one-to-one with those persisted
                // turns instead of silently attaching a later request to an
                // older pending form. Otherwise the later turn is invisible
                // until a history reload reconstructs it from storage.
                const part = this.createGuestOrderAccessPart(data);
                const text = Object.prototype.hasOwnProperty.call(data, 'content')
                    ? String(data.content || '')
                    : (part.purpose === 'support'
                        ? 'Verify your email before starting human support.'
                        : 'To protect your order information, first verify the email used at checkout.');
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = {
                        role: 'assistant',
                        request_id: data.request_id || this.activeRequestId || '',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: []
                    };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                if (text && !message.parts.some(candidate => candidate?.type === 'text')) {
                    message.parts.push({
                        id: Date.now() + Math.random(),
                        type: 'text',
                        raw: text,
                        html: sanitizeStreamingHtml(text)
                    });
                }
                message.parts.push(part);
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => this.scrollToBottom());
                return part;
            },

            resetGuestOrderAccessForm(part) {
                if (!part || part.busy || part.state === 'expired') return;
                part.state = 'email';
                part.email = '';
                part.code = '';
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            normalizeGuestOrderAccessExpiry(value) {
                const numeric = Math.floor(Number(value) || 0);
                if (!numeric) return 0;
                return numeric < 10000000000 ? numeric * 1000 : numeric;
            },

            expireGuestOrderAccessForm(part) {
                if (!part || part.state === 'verified') return;
                if (part.expiryTimer) {
                    window.clearInterval(part.expiryTimer);
                    part.expiryTimer = null;
                }
                part.state = 'expired';
                part.remainingSeconds = 0;
                part.busy = false;
                part.email = '';
                part.code = '';
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            scheduleGuestOrderAccessFormExpiry(part) {
                if (!part || part.state === 'verified' || part.state === 'expired') return;
                if (part.expiryTimer) window.clearInterval(part.expiryTimer);
                const update = () => {
                    part.remainingSeconds = Math.max(0, Math.ceil((Number(part.expiresAt) - Date.now()) / 1000));
                    if (part.remainingSeconds <= 0) {
                        this.expireGuestOrderAccessForm(part);
                        this.scheduleGuestSessionSnapshot();
                    }
                };
                update();
                if (part.state !== 'expired') part.expiryTimer = window.setInterval(update, 1000);
            },

            guestOrderAccessCountdownLabel(part) {
                const seconds = Math.max(0, Math.floor(Number(part?.remainingSeconds) || 0));
                const minutes = Math.floor(seconds / 60);
                return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
            },

            applyGuestOrderAccessState(state, expiresAt = null) {
                const requestedVerifiedState = state === 'verified';
                const normalizedExpiry = requestedVerifiedState
                    ? this.normalizeGuestOrderAccessExpiry(expiresAt)
                    : 0;
                const nextState = requestedVerifiedState
                    && (!normalizedExpiry || normalizedExpiry > Date.now())
                    ? 'verified'
                    : 'email';

                if (this.guestOrderAccessExpiryTimer) {
                    window.clearTimeout(this.guestOrderAccessExpiryTimer);
                    this.guestOrderAccessExpiryTimer = null;
                }
                this.guestOrderAccessState = nextState;
                this.guestOrderAccessExpiresAt = normalizedExpiry;

                this.messages.forEach((message) => {
                    if (!Array.isArray(message?.parts)) return;
                    message.parts.forEach((part) => {
                        if (part?.type !== 'guest_order_access' || part.purpose === 'support') return;
                        part.state = nextState;
                        part.busy = false;
                        part.code = '';
                        part.notice = '';
                        part.noticeVariant = nextState === 'verified' ? 'success' : 'neutral';
                        part.email = '';
                    });
                });
                if (nextState === 'verified' && normalizedExpiry > Date.now()) {
                    this.guestOrderAccessExpiryTimer = window.setTimeout(() => {
                        this.applyGuestOrderAccessState('email');
                        if (typeof this.broadcastCrossTabEvent === 'function') {
                            this.broadcastCrossTabEvent('guest_order_access_state', { state: 'email' });
                        }
                    }, normalizedExpiry - Date.now());
                }
                this.scheduleGuestSessionSnapshot();
            },

            requestGuestOrderOtp(part) {
                if (!part || part.busy || part.state === 'expired') return;
                const email = String(part.email || '').trim();
                if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
                    part.notice = 'Enter a valid checkout email address.';
                    part.noticeVariant = 'error';
                    return;
                }
                if (!this.socket || !this.wsConnected) {
                    part.notice = 'The secure chat connection is unavailable. Please try again in a moment.';
                    part.noticeVariant = 'error';
                    return;
                }

                part.email = email;
                // Support verification is deliberately separate from guest
                // order access. Starting a support OTP must not revoke an
                // already verified checkout session.
                if (part.purpose !== 'support') {
                    this.guestOrderAccessState = 'email';
                    this.guestOrderAccessExpiresAt = 0;
                    if (this.guestOrderAccessExpiryTimer) {
                        window.clearTimeout(this.guestOrderAccessExpiryTimer);
                        this.guestOrderAccessExpiryTimer = null;
                    }
                    if (typeof this.broadcastCrossTabEvent === 'function') {
                        this.broadcastCrossTabEvent('guest_order_access_state', { state: 'email' });
                    }
                }
                part.notice = '';
                part.busy = true;
                this.socket.send(JSON.stringify({
                    action: 'guest_order_request_otp',
                    form_id: String(part.id),
                    purpose: part.purpose === 'support' ? 'support' : 'order',
                    email
                }));
            },

            verifyGuestOrderOtp(part) {
                if (!part || part.busy || part.state === 'expired') return;
                if (!/^\d{6}$/.test(String(part.code || ''))) {
                    part.notice = 'Enter the six-digit verification code.';
                    part.noticeVariant = 'error';
                    return;
                }
                if (!this.socket || !this.wsConnected) {
                    part.notice = 'The secure chat connection is unavailable. Please try again in a moment.';
                    part.noticeVariant = 'error';
                    return;
                }

                part.notice = '';
                part.busy = true;
                this.socket.send(JSON.stringify({
                    action: 'guest_order_verify_otp',
                    form_id: String(part.id),
                    purpose: part.purpose === 'support' ? 'support' : 'order',
                    email: String(part.email || '').trim(),
                    code: String(part.code || '')
                }));
            },

            loadSupportPortal(part) {
                if (!part || part.purpose !== 'support' || !this.socket || !this.wsConnected) return;
                part.portalLoading = true;
                part.notice = '';
                this.socket.send(JSON.stringify({
                    action: 'support_portal_load',
                    form_id: String(part.id)
                }));
            },

            openSupportTicketForm(part) {
                if (!part || part.busy) return;
                part.ticketFormOpen = true;
                part.notice = '';
                this.$nextTick(() => this.scrollToBottom());
            },

            closeSupportTicketForm(part) {
                if (!part || part.busy) return;
                part.ticketFormOpen = false;
                part.ticketSubject = '';
                part.ticketMessage = '';
                part.ticketCategory = 'general';
            },

            submitSupportTicket(part) {
                if (!part || part.busy || !this.socket || !this.wsConnected) return;
                const subject = String(part.ticketSubject || '').trim();
                const message = String(part.ticketMessage || '').trim();
                if (!subject || !message) {
                    part.notice = 'Enter a subject and describe what you need help with.';
                    part.noticeVariant = 'error';
                    return;
                }
                part.busy = true;
                part.notice = '';
                this.socket.send(JSON.stringify({
                    action: 'support_ticket_create',
                    form_id: String(part.id),
                    source_conversation_id: Number(this.activeConversationId) || 0,
                    category: String(part.ticketCategory || 'general'),
                    subject: subject.slice(0, 255),
                    message: message.slice(0, 4000)
                }));
            },

            openSupportTicket(ticket, part = null) {
                const conversationId = Number(ticket?.conversation_id) || 0;
                if (!conversationId) {
                    if (part) {
                        part.notice = 'This ticket is closed and its previous conversation is no longer available.';
                        part.noticeVariant = 'neutral';
                    }
                    return;
                }
                this.switchConversation(conversationId, true);
            },

             findGeneratedImagePart(imageId) {
                const id = String(imageId || '');
                for (const message of this.messages) {
                    if (!Array.isArray(message?.parts)) continue;
                    const part = message.parts.find(candidate => candidate?.type === 'image' && String(candidate.imageId || candidate.id) === id);
                    if (part) return part;
                }
                return null;
            },

            upsertGeneratedImagePart(data, status = 'generating') {
                const imageId = String(data?.image_id || '');
                if (!imageId) return null;

                let part = this.findGeneratedImagePart(imageId);
                if (part) {
                    Object.assign(part, {
                        status,
                        ...(data.url ? { url: String(data.url) } : {}),
                        ...(data.alt ? { alt: String(data.alt).slice(0, 400) } : {}),
                        ...(data.message ? { error: String(data.message).slice(0, 400) } : {}),
                        ...(data.size ? { size: String(data.size) } : {}),
                        ...(data.quality ? { quality: String(data.quality) } : {})
                    });
                    return part;
                }

                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;
                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = { role: 'assistant', feedbackEnabled: false, feedbackBusy: false, parts: [] };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                part = {
                    id: Date.now() + Math.random(),
                    imageId,
                    type: 'image',
                    status,
                    startedAt: Number(data.started_at) || Date.now(),
                    url: String(data.url || ''),
                    alt: String(data.alt || 'Generated image').slice(0, 400),
                    prompt: String(data.prompt || '').slice(0, 4000),
                    error: String(data.message || ''),
                    size: String(data.size || ''),
                    quality: String(data.quality || '')
                };
                message.parts.push(part);
                return part;
            },

            handleGeneratedImageError(part, event) {
                if (!part) return;
                part.status = 'error';
                const fallback = 'The generated image could not be loaded. Please try again.';
                const translated = typeof this.t === 'function'
                    ? this.t('generated_image_load_failed')
                    : '';
                part.error = translated && translated !== 'generated_image_load_failed' ? translated : fallback;
                if (event?.target) {
                    event.target.removeAttribute('src');
                }
                this.scheduleGuestSessionSnapshot?.();
            },

            async setMessageFeedback(index, value) {
                const message = this.messages[index];
                const messageId = Number(message?.entity_id) || 0;
                const conversationId = Number(this.activeConversationId) || 0;
                if (!message?.feedbackEnabled
                    || message.feedbackBusy
                    || !messageId
                    || !conversationId
                    || !urls.feedback
                    || !['positive', 'negative'].includes(value)) return;

                const previous = {
                    rating: message.feedback || null,
                    reason: String(message.feedbackReason || ''),
                    comment: String(message.feedbackComment || ''),
                    detailsSaved: message.feedbackDetailsSaved === true
                };
                const nextValue = previous.rating === value ? null : value;
                message.feedbackBusy = true;
                message.feedback = nextValue;
                if (nextValue === 'negative') {
                    message.feedbackReason = 'incorrect';
                    message.feedbackComment = '';
                    message.feedbackDetailsSaved = false;
                } else {
                    message.feedbackReason = '';
                    message.feedbackComment = '';
                    message.feedbackDetailsSaved = false;
                }
                this.messageFeedback = { ...this.messageFeedback, [messageId]: nextValue };
                try {
                    await postFeedback({
                        conversation_id: conversationId,
                        message_id: messageId,
                        rating: nextValue || ''
                    });
                    this.scheduleCrossTabConversationSync?.(conversationId);
                } catch (error) {
                    message.feedback = previous.rating;
                    message.feedbackReason = previous.reason;
                    message.feedbackComment = previous.comment;
                    message.feedbackDetailsSaved = previous.detailsSaved;
                    this.messageFeedback = { ...this.messageFeedback, [messageId]: previous.rating };
                    this.setTransportNotice('feedback-failed', 'Rating not saved', error.message || 'Please try again.');
                } finally {
                    message.feedbackBusy = false;
                    this.scheduleGuestSessionSnapshot?.();
                }
            },

            dismissMessageFeedback(index) {
                const message = this.messages[index];
                if (message?.feedback !== 'negative' || message.feedbackBusy) return;

                return this.setMessageFeedback(index, 'negative');
            },

            async submitMessageFeedbackDetails(index) {
                const message = this.messages[index];
                const messageId = Number(message?.entity_id) || 0;
                const conversationId = Number(this.activeConversationId) || 0;
                if (message?.feedback !== 'negative' || !messageId || !conversationId || !urls.feedback) return;
                message.feedbackBusy = true;
                try {
                    await postFeedback({
                        conversation_id: conversationId,
                        message_id: messageId,
                        rating: 'negative',
                        reason: String(message.feedbackReason || 'other'),
                        comment: String(message.feedbackComment || '').slice(0, 1000)
                    });
                    message.feedbackDetailsSaved = true;
                    this.scheduleCrossTabConversationSync?.(conversationId);
                } catch (error) {
                    this.setTransportNotice('feedback-details-failed', 'Feedback not saved', error.message || 'Please try again.');
                } finally {
                    message.feedbackBusy = false;
                    this.scheduleGuestSessionSnapshot?.();
                }
            },

            toggleReasoning(part) {
                if (part) {
                    const nextExpanded = part.isExpanded === false;
                    // Keep the disclosure state separate from the stream
                    // projection. Incoming thinking/action events may update
                    // the same reasoning object many times; they must not
                    // reinterpret a previous automatic state as a shopper
                    // click. This mirrors Codex's local accordion state.
                    part.wasManuallyToggled = true;
                    part.isManuallyCollapsed = !nextExpanded;
                    part.isExpanded = nextExpanded;
                    this.scheduleGuestSessionSnapshot?.();
                }
            },

            // Codex reasoning lifecycle: while the model works the header is
            // a shimmering "Thinking"; the first answer chunk collapses the
            // section, later thinking/tool events open it again, and `done`
            // freezes the elapsed time into "Thought for Ns" (collapsed
            // unless the shopper toggled it manually).
            freezeReasoningElapsed(part) {
                if (!part || part.elapsedMs != null) return;
                const startedAt = Number(part.startedAt) || 0;
                if (startedAt > 0) {
                    part.elapsedMs = Math.max(0, Date.now() - startedAt);
                }
            },

            collapseReasoningForAnswer(message = null) {
                const target = message || (this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null);
                if (!target || target.role !== 'assistant' || !Array.isArray(target.parts)) return;

                target.parts.forEach((part) => {
                    if (part?.type === 'reasoning') {
                        this.freezeReasoningElapsed(part);
                        part.isExpanded = false;
                        part.isManuallyCollapsed = false;
                    }
                });
            },

            currentLiveReasoningPart() {
                const message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;
                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) return null;
                return message.parts.find(part => part?.type === 'reasoning') || null;
            },

            // A new reasoning/tool event after the answer started re-opens
            // the section the same way Codex spawns a fresh "Thinking" item.
            markReasoningResumed() {
                const part = this.currentLiveReasoningPart();
                if (part) {
                    part.autoCollapsed = false;
                    // Thinking resumed after the previous section closed:
                    // drop the frozen "Thought for Ns" so the shimmering
                    // "Thinking" header comes back until it closes again.
                    part.elapsedMs = null;
                    if (part.isManuallyCollapsed !== true) {
                        part.isExpanded = true;
                    }
                }
            },

            // Reasoning text is emitted by the selected provider. The UI does
            // not invent progress sentences: it only joins the provider's
            // streamed deltas for the same reasoning step.
            isProviderReasoningStep(event) {
                const source = String(event?.source || '');
                const isRestoredProviderStep = source === ''
                    && String(event?.id || '').startsWith('provider-reasoning-')
                    && String(event?.content || '').trim() !== '';
                return event?.type === 'step'
                    && (source === 'provider_reasoning' || isRestoredProviderStep);
            },

            isVisibleReasoningEvent(event) {
                return event?.type === 'activity'
                    || this.isProviderReasoningStep(event);
            },

            appendProviderReasoningDelta(data) {
                if (data?.visibility !== 'public') return;
                const delta = String(data.delta ?? data.content ?? '');
                if (!delta) return;
                if (!Array.isArray(this.thinkingEvents)) this.thinkingEvents = [];

                const stepId = String(data.step_id || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'default';
                const id = `provider-reasoning-${stepId}`;
                const index = this.thinkingEvents.findIndex(event => event?.id === id);
                const previous = index === -1 ? null : this.thinkingEvents[index];
                const next = {
                    id,
                    type: 'step',
                    source: 'provider_reasoning',
                    content: `${String(previous?.content || '')}${delta}`.slice(0, 16000),
                    state: 'running'
                };
                if (index === -1) this.thinkingEvents.push(next);
                else this.thinkingEvents.splice(index, 1, next);
            },

            discardProviderReasoningStep(data) {
                if (data?.visibility !== 'public' || !Array.isArray(this.thinkingEvents)) return;
                const stepId = String(data.step_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
                if (!stepId) return;
                const id = `provider-reasoning-${stepId}`;
                this.thinkingEvents = this.thinkingEvents.filter(event => event?.id !== id);
            },

            syncLiveReasoningPart() {
                const events = (Array.isArray(this.thinkingEvents) ? this.thinkingEvents : [])
                    .filter(event => event?.type === 'activity'
                        || this.isVisibleReasoningEvent(event));
                const activities = Array.isArray(this.toolActivities) ? this.toolActivities : [];
                const hasReasoning = events.length > 0 || activities.length > 0;
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!hasReasoning) {
                    if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) return null;
                    const reasoningIndex = message.parts.findIndex(part => part?.type === 'reasoning');
                    if (reasoningIndex !== -1) message.parts.splice(reasoningIndex, 1);
                    if (message.parts.length === 0) {
                        this.messages.splice(this.currentAiMessageIndex, 1);
                        this.currentAiMessageIndex = -1;
                    }
                    return null;
                }

                // Create the assistant bubble as soon as the first reasoning
                // event arrives. The old implementation rendered a separate
                // full-width thinking card, then rebuilt the same content in a
                // message bubble when the first answer chunk arrived.
                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = {
                        role: 'assistant',
                        request_id: this.activeRequestId || '',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: []
                    };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                let reasoningPart = message.parts.find(part => part?.type === 'reasoning');
                if (!reasoningPart) {
                    reasoningPart = {
                        id: 'reasoning-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                        type: 'reasoning',
                        events: [],
                        steps: [],
                        activities: [],
                        startedAt: Date.now(),
                        // Keep live actions visible. The shopper can collapse
                        // them manually, and subsequent deltas preserve that.
                        isExpanded: true,
                        isManuallyCollapsed: false,
                        wasManuallyToggled: false,
                        autoCollapsed: false
                    };
                    message.parts.unshift(reasoningPart);
                }

                // A stream is authoritative while it is active. Do not let
                // an action update, a legacy snapshot, or a history refresh
                // turn the live Thinking panel into a completed-looking
                // header. Only an explicit shopper collapse can keep it shut.
                // `autoCollapsed` marks the Codex-style handoff moment when
                // the answer text started; later reasoning events clear it.
                if (this.isLoading
                    && reasoningPart.isManuallyCollapsed !== true
                    && reasoningPart.autoCollapsed !== true) {
                    reasoningPart.isExpanded = true;
                }

                reasoningPart.events = [...events];
                reasoningPart.steps = events.filter(event => event?.type === 'step');
                reasoningPart.activities = [...activities];
                return reasoningPart;
            },

            isReasoningLive(part, index = null) {
                if (!this.isLoading || !part) return false;
                if (part.elapsedMs != null) return false;
                if (index !== null && index !== this.currentAiMessageIndex) return false;
                const livePart = this.currentLiveReasoningPart();
                return livePart === part || livePart === null;
            },

            // Codex duration formatting: hidden under one second, then
            // "12s", "3m 24s", "1h 2m 3s".
            formatElapsedMs(elapsedMs, { underOneSecond = 'hidden' } = {}) {
                const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
                if (totalSeconds < 1) {
                    return underOneSecond === 'zero' ? '0s' : '';
                }
                if (totalSeconds < 60) {
                    return `${totalSeconds}s`;
                }
                const hours = 3600;
                const days = Math.floor(totalSeconds / (hours * 24));
                const hourPart = Math.floor(totalSeconds / hours) % 24;
                const minutePart = Math.floor((totalSeconds % hours) / 60);
                const secondPart = totalSeconds % 60;
                if (days > 0 || hourPart > 0) {
                    const parts = [];
                    if (days > 0) parts.push(`${days}d`);
                    if (hourPart > 0) parts.push(`${hourPart}h`);
                    if (minutePart > 0) parts.push(`${minutePart}m`);
                    if (secondPart > 0) parts.push(`${secondPart}s`);
                    return parts.join(' ');
                }
                return secondPart === 0 ? `${minutePart}m` : `${minutePart}m ${secondPart}s`;
            },

            reasoningTitle(part, index = null) {
                if (!part) return this.t('thought_process');
                if (part.elapsedMs != null) {
                    return this.t('thought_for', { 1: this.formatElapsedMs(part.elapsedMs, { underOneSecond: 'zero' }) });
                }
                if (this.isReasoningLive(part, index)) {
                    return this.t('thinking');
                }
                const count = this.reasoningActivities(part).length;
                if (count <= 1) return this.t('thought_process_1_step');
                return this.t('thought_process_steps', { 1: count });
            },

            reasoningSummary(part) {
                if (!part) return '';
                const events = Array.isArray(part.events) ? part.events : [];
                const activities = events.filter(event => event?.type === 'activity');
                const fallback = Array.isArray(part.activities) ? part.activities : [];
                const latest = (activities.length ? activities : fallback).slice(-1)[0];
                return latest ? this.toolActivityLabel(latest) : '';
            },

            reasoningActivities(part) {
                if (!part) return [];
                const events = Array.isArray(part.events) ? part.events : [];
                const activities = events.filter(event => event?.type === 'activity');
                return activities.length
                    ? activities
                    : (Array.isArray(part.activities) ? part.activities : []);
            },

            reasoningSteps(part) {
                if (!part) return [];
                const events = Array.isArray(part.events) ? part.events : [];
                return events.filter(event => this.isProviderReasoningStep(event));
            },

            // Codex exposes customer-safe progress and tool items. Afd uses
            // only progress derived from an explicit tool action, never raw
            // provider chain-of-thought or legacy reasoning text.
            reasoningTimeline(part) {
                if (!part) return [];
                const events = Array.isArray(part.events) ? part.events : [];
                if (events.length > 0) {
                    return events.filter(event => event?.type === 'activity'
                        || this.isVisibleReasoningEvent(event));
                }
                const steps = (Array.isArray(part.steps) ? part.steps : [])
                    .filter(step => this.isProviderReasoningStep(step))
                    .map(step => ({ ...step, type: 'step' }));
                const activities = (Array.isArray(part.activities) ? part.activities : [])
                    .map(activity => ({ ...activity, type: 'activity' }));
                return [...steps, ...activities];
            },

            // Codex shows "Running command for 3s" while a tool works; the
            // completed row remains a stable label without a stale timer.
            activityElapsedMs(activity) {
                if (!activity || activity.state === 'running') {
                    const startedAt = Number(activity?.startedAt) || 0;
                    if (!startedAt) return null;
                    return Math.max(0, (activity.state === 'running' ? this.streamNow : Date.now()) - startedAt);
                }
                const startedAt = Number(activity.startedAt) || 0;
                const completedAt = Number(activity.completedAt) || 0;
                if (!startedAt || !completedAt || completedAt < startedAt) return null;
                return completedAt - startedAt;
            },

            // Keep elapsed time on the live action only. Once the action is
            // complete the row stays stable like Codex instead of leaving a
            // misleading trailing "1s" beside the completed label.
            activityDurationLabel(activity) {
                if (!activity || activity.state !== 'running') return '';
                const elapsed = this.activityElapsedMs(activity);
                if (elapsed === null) return '';
                return this.formatElapsedMs(elapsed);
            },

            activitySummaryLabel(part) {
                const activities = this.reasoningActivities(part);
                const count = activities.length;
                if (count <= 1) return this.t('actions_checked_1');
                return this.t('actions_checked', { 1: count });
            },

            isActivityListOpen(msg, part) {
                if (!part) return false;
                return part.activitiesExpanded === true;
            },

            toggleActivityList(part) {
                if (!part) return;
                part.activitiesExpanded = part.activitiesExpanded !== true;
                this.scheduleGuestSessionSnapshot?.();
            },

            workedForLabel(message) {
                const elapsedMs = Number(message?.workedForMs) || 0;
                return this.t('worked_for', { 1: this.formatElapsedMs(elapsedMs, { underOneSecond: 'zero' }) });
            },

            // Codex turn footer: while the turn runs the divider reads
            // "Working" (no timer under one second), then "Working for Ns"
            // ticking once per second; `done` freezes it into
            // "Worked for Ns".
            turnDividerLabel(msg, index = null) {
                if (!msg || msg.deleted) return '';
                const isLiveTurn = this.isLoading
                    && index !== null
                    && index === this.currentAiMessageIndex;
                if (isLiveTurn) {
                    const startedAt = Number(this.responseStartedAt) || 0;
                    if (!startedAt) return '';
                    const elapsedMs = Math.max(0, this.streamNow - startedAt);
                    if (elapsedMs < 1000) return this.t('working');
                    return this.t('working_for', { 1: this.formatElapsedMs(elapsedMs) });
                }
                return this.workedForLabel(msg);
            },

            // ZCode separates internal work history from the customer-facing
            // answer. A running turn starts open; after completion, the same
            // duration row remains visible but the details are folded away.
            isTurnHistoryOpen(msg, index = null) {
                if (!msg) return false;
                const isLiveTurn = this.isLoading
                    && index !== null
                    && index === this.currentAiMessageIndex;
                if (isLiveTurn) return msg.historyExpanded !== false;
                return msg.historyExpanded === true;
            },

            toggleTurnHistory(msg, index = null) {
                if (!msg) return;
                const nextExpanded = !this.isTurnHistoryOpen(msg, index);
                msg.historyExpanded = nextExpanded;
                (Array.isArray(msg.parts) ? msg.parts : []).forEach((part) => {
                    if (part?.type !== 'reasoning') return;
                    part.isExpanded = nextExpanded;
                    part.isManuallyCollapsed = !nextExpanded;
                    part.wasManuallyToggled = true;
                    part.activitiesExpanded = nextExpanded;
                });
                this.scheduleGuestSessionSnapshot?.();
            },

            messageTimeLabel(message) {
                const raw = message?.created_at || message?.createdAt || '';
                if (!raw) return '';
                let timestamp = raw instanceof Date ? raw.getTime() : Date.parse(raw);
                if (!Number.isFinite(timestamp) && typeof raw === 'number') {
                    timestamp = raw < 1000000000000 ? raw * 1000 : raw;
                }
                if (!Number.isFinite(timestamp)) return '';
                try {
                    return new Intl.DateTimeFormat(undefined, {
                        hour: '2-digit',
                        minute: '2-digit'
                    }).format(new Date(timestamp));
                } catch (error) {
                    return '';
                }
            },

            renderMarkdown(content) {
                if (!content) return '';
                const cleanContent = typeof sanitizeCustomerResponseText === 'function'
                    ? sanitizeCustomerResponseText(content)
                    : content;
                return typeof sanitizeHtml === 'function'
                    ? sanitizeHtml(cleanContent)
                    : (window.marked ? window.marked.parse(cleanContent) : String(cleanContent));
            },

            renderStreamingMarkdown(content) {
                if (!content) return '';
                const cleanContent = typeof sanitizeCustomerResponseText === 'function'
                    ? sanitizeCustomerResponseText(content)
                    : content;
                return typeof sanitizeStreamingHtml === 'function'
                    ? sanitizeStreamingHtml(cleanContent)
                    : (typeof sanitizeHtml === 'function' ? sanitizeHtml(cleanContent) : String(cleanContent));
            },

            isProductPageLoading(part) {
                return Boolean(part?.id && this.productPageLoading[String(part.id)]);
            },

            productResultsSummary(part) {
                const payload = part?.payload || {};
                const pagination = payload.pagination || {};
                const coverage = payload.coverage || {};
                // `total` is duplicated in the v2 product contract so the
                // summary remains truthful when a legacy/history adapter
                // omits coverage or pagination while preserving the payload.
                const total = Number(coverage.total ?? pagination.total ?? payload.total);
                const visible = Number(coverage.shown
                    ?? (Array.isArray(payload.items) ? payload.items.length : pagination.returned || 0));

                if (!Number.isFinite(total) || total < 0 || !visible) return '';
                const hasMore = pagination.has_more === true
                    || pagination.can_load_more === true
                    || Boolean(payload.continuation);
                if (visible >= total && !hasMore) {
                    return typeof this.t === 'function'
                        ? this.t('catalog_showing_all', { 1: total })
                        : `Showing all ${total} product${total === 1 ? '' : 's'}`;
                }
                return typeof this.t === 'function'
                    ? this.t('catalog_showing_page', { 1: visible, 2: total })
                    : `Showing ${visible} of ${total} matching products`;
            },

            productLoadMoreLabel(part) {
                const payload = part?.payload || {};
                const pagination = payload.pagination || {};
                const total = Number(pagination.total ?? payload.total);
                const visible = Array.isArray(payload.items) ? payload.items.length : 0;
                const pageSize = Math.max(1, Number(pagination.page_size) || 5);
                const remaining = Number.isFinite(total) ? Math.max(0, total - visible) : pageSize;
                const nextCount = Math.min(pageSize, remaining || pageSize);

                return this.isProductPageLoading(part)
                    ? (typeof this.t === 'function' ? this.t('catalog_loading') : 'Loading products…')
                    : (typeof this.t === 'function'
                        ? this.t('catalog_show_more', { 1: nextCount })
                        : `Show ${nextCount} more`);
            },

            async loadMoreProducts(part) {
                if (!part || this.isProductPageLoading(part)) return;
                const continuation = String(part.payload?.continuation || '');
                if (!continuation) return;

                if (!this.socket || !this.wsConnected) {
                    await this.connectWebSocket();
                    await this.waitForSecureSocket();
                }
                if (!this.socket || !this.wsConnected) {
                    this.setTransportNotice(
                        'catalog-page-unavailable',
                        typeof this.t === 'function' ? this.t('catalog_page_unavailable_title') : 'More products are unavailable',
                        typeof this.t === 'function'
                            ? this.t('catalog_page_unavailable_copy')
                            : 'The secure chat connection is reconnecting. Please try again in a moment.'
                    );
                    return;
                }

                const partId = String(part.id);
                this.productPageLoading = { ...this.productPageLoading, [partId]: true };
                try {
                    this.socket.send(JSON.stringify({
                        action: 'load_product_page',
                        product_part_id: partId,
                        continuation
                    }));
                } catch (error) {
                    const loading = { ...this.productPageLoading };
                    delete loading[partId];
                    this.productPageLoading = loading;
                }
            },

            findProductPart(partId) {
                const id = String(partId || '');
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'products' && String(candidate.id) === id);
                    if (part) return part;
                }
                return null;
            },

            completeProductPageRequest(partId) {
                const loading = { ...this.productPageLoading };
                delete loading[String(partId || '')];
                this.productPageLoading = loading;
            },

            appendProductPage(data) {
                const part = this.findProductPart(data.product_part_id);
                if (!part) return;

                const incomingPayload = data.products && typeof data.products === 'object' ? data.products : null;
                const incomingItems = Array.isArray(incomingPayload?.items) ? incomingPayload.items : [];
                const knownIds = new Set((part.payload?.items || [])
                    .map(item => Number(item?.id || 0))
                    .filter(Boolean));
                const uniqueItems = incomingItems.filter(item => {
                    const id = Number(item?.id || 0);
                    return id > 0 && !knownIds.has(id);
                });

                if (uniqueItems.length > 0 && data.html) {
                    part.html = mergeProductGridHtml(
                        part.html,
                        hydrateProductGridHtml(data.html)
                    );
                }

                const existingPayload = part.payload && typeof part.payload === 'object' ? part.payload : {};
                part.payload = mergeProductPayload(existingPayload, incomingPayload);
                this.completeProductPageRequest(data.product_part_id);
                this.scheduleGuestSessionSnapshot();
                this.scheduleCrossTabConversationSync(this.activeConversationId, 80);
                this.$nextTick(() => this.scrollToBottom());
            },

            cancelEditMessage() {
                this.editingMessageIndex = null;
                this.editingMessageDraft = '';
                this.editingMessageAttachments = [];
            },

            editMessage(index) {
                if (this.isReadingAttachments) return;
                const message = this.messages[index];
                if (!message || message.role !== 'user' || message.deleted || message.mutationBusy) return;

                // Editing replaces a conversation branch. Stop the active
                // response first so late chunks cannot enter that old branch.
                if (this.isLoading) {
                    this.stopCurrentResponse();
                }

                this.editingMessageIndex = index;
                this.editingMessageDraft = message.content || '';
                this.editingMessageAttachments = this.copyMessageAttachments(message.attachments);
                this.messageFeedback = {};
                this.copiedMessageIndex = null;
                this.$nextTick(() => {
                    this.resizeEditMessageInput();
                    const input = this.getEditMessageInput();
                    if (input) input.focus();
                });
            },

            handleEditComposerKeydown(event, index) {
                if (this.isLoading || this.isReadingAttachments || !event) return;
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

                event.preventDefault();
                this.submitEditedMessage(index);
            },

            async submitEditedMessage(index) {
                if (this.isLoading || this.isReadingAttachments) return;
                if (this.editingMessageIndex !== index) return;

                const message = this.messages[index];
                if (!message || message.role !== 'user') return;

                const draftText = this.editingMessageDraft.trim();
                if (this.humanSupportActive) {
                    if (!draftText) return;
                    this.sendSupportMessageMutation(index, 'edit', draftText);
                    return;
                }
                let draftAttachments;
                try {
                    draftAttachments = await this.prepareAttachmentsForResend(this.editingMessageAttachments);
                } catch (error) {
                    this.setTransportNotice(
                        'attachment-resend-failed',
                        'Image could not be reused',
                        error.message || 'The original image could not be loaded. Your message was not changed.'
                    );
                    return;
                }
                if (!draftText && draftAttachments.length === 0) return;

                const replaceFromMessageId = Number(message.entity_id) || null;
                this.cancelEditMessage();
                this.messages = this.messages.slice(0, index);
                this.hasStartedChat = this.messages.length > 0;
                this.currentAiMessageIndex = -1;
                this.statusMessage = '';
                this.messageFeedback = {};
                this.copiedMessageIndex = null;

                await this.sendMessagePayload(
                    draftText,
                    draftAttachments,
                    draftText,
                    false,
                    replaceFromMessageId
                );
            },

            clearSupportMessageMutationBusy(messageId) {
                const targetId = Number(messageId) || 0;
                const message = this.messages.find(item => Number(item?.entity_id) === targetId);
                if (message) message.mutationBusy = false;
            },

            applySupportMessageMutation(data) {
                const conversationId = Number(data.conversation_id) || 0;
                const messageId = Number(data.message_id) || 0;
                if (!messageId || conversationId !== Number(this.activeConversationId)) return;
                const index = this.messages.findIndex(item => Number(item?.entity_id) === messageId);
                if (index < 0) {
                    this.refreshSupportConversation(conversationId);
                    return;
                }
                const message = this.messages[index];
                message.mutationBusy = false;
                if (data.operation === 'delete') {
                    message.deleted = true;
                    message.deletedAt = String(data.deleted_at || '');
                    message.content = '';
                    message.attachments = [];
                    message.parts = [];
                    message.feedbackEnabled = false;
                } else {
                    const content = String(data.content || '').trim();
                    message.deleted = false;
                    message.edited = true;
                    message.editedAt = String(data.edited_at || '');
                    if (message.role === 'user') {
                        message.content = content;
                    } else {
                        message.parts = [{
                            id: `${messageId}-edited`,
                            type: 'text',
                            raw: content,
                            html: sanitizeHtml(content)
                        }];
                    }
                }
                if (this.editingMessageIndex === index) this.cancelEditMessage();
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => this.scrollToBottom());
            },

            sendSupportMessageMutation(index, operation, content = '') {
                const message = this.messages[index];
                const conversationId = Number(this.activeConversationId) || 0;
                const messageId = Number(message?.entity_id) || 0;
                if (!this.humanSupportActive || !conversationId || !messageId || message?.deleted || message?.mutationBusy) return;
                if (!this.socket || !this.wsConnected || this.socket.readyState !== WebSocket.OPEN) {
                    this.setTransportNotice(
                        'support-message-mutation-offline',
                        'Live connection required',
                        'Reconnect before changing a support message.'
                    );
                    return;
                }
                message.mutationBusy = true;
                const requestId = `support-mutation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                this.socket.send(JSON.stringify({
                    action: operation === 'delete' ? 'support_message_delete' : 'support_message_edit',
                    request_id: requestId,
                    conversation_id: conversationId,
                    message_id: messageId,
                    content: operation === 'edit' ? String(content || '').trim().slice(0, 4000) : ''
                }));
            },

            requestDeleteSupportMessage(index, event = null) {
                const message = this.messages[index];
                if (!this.humanSupportActive || !message || message.role !== 'user' || message.deleted) return;
                this.openConfirmationDialog({
                    kicker: 'Support message',
                    title: 'Delete this message?',
                    description: 'The message will be hidden for you and support staff, while an audit copy remains securely stored.',
                    preview: String(message.content || '').trim().slice(0, 240),
                    icon: 'delete',
                    confirmLabel: 'Delete message',
                    confirmIcon: 'delete',
                    variant: 'danger',
                    action: () => this.sendSupportMessageMutation(index, 'delete')
                }, event);
            },

            async retryFromMessage(index) {
                if (this.isLoading || this.isReadingAttachments) return;

                let userIndex = index;
                if (!this.messages[userIndex] || this.messages[userIndex].role !== 'user') {
                    userIndex = -1;
                    for (let i = index - 1; i >= 0; i--) {
                        if (this.messages[i] && this.messages[i].role === 'user') {
                            userIndex = i;
                            break;
                        }
                    }
                }

                const message = this.messages[userIndex];
                if (!message || message.role !== 'user') return;

                let retryAttachments;
                try {
                    retryAttachments = await this.prepareAttachmentsForResend(message.attachments);
                } catch (error) {
                    this.setTransportNotice(
                        'attachment-resend-failed',
                        'Image could not be reused',
                        error.message || 'The original image could not be loaded. The response was not regenerated.'
                    );
                    return;
                }
                const replaceFromMessageId = Number(message.entity_id) || null;
                this.cancelEditMessage();
                this.messages = this.messages.slice(0, userIndex);
                this.hasStartedChat = this.messages.length > 0;
                this.currentAiMessageIndex = -1;
                this.statusMessage = '';
                this.messageFeedback = {};
                this.copiedMessageIndex = null;
                const defaultSingleImage = typeof this.t === 'function' ? this.t('sent_an_image') : (typeof window.$t === 'function' ? window.$t('Sent an image') : 'Sent an image');
                await this.sendMessagePayload(
                    message.content || '',
                    retryAttachments,
                    message.content || defaultSingleImage,
                    false,
                    replaceFromMessageId
                );
            },

            async sendMessage() {
                if ((!this.userInput.trim() && this.imageAttachments.length === 0) || this.isLoading || this.isReadingAttachments) return;
                const text = this.userInput.trim();
                const attachments = this.imageAttachments.map(attachment => ({ ...attachment }));
                const defaultSingleImage = typeof this.t === 'function' ? this.t('sent_an_image') : (typeof window.$t === 'function' ? window.$t('Sent an image') : 'Sent an image');
                const defaultMultiImages = typeof this.t === 'function' ? this.t('sent_images_count', { 1: attachments.length }) : (typeof window.$t === 'function' ? window.$t('Sent %1 images').replace('%1', attachments.length) : `Sent ${attachments.length} images`);
                const displayText = text || (attachments.length > 1 ? defaultMultiImages : defaultSingleImage);
                this.cancelEditMessage();
                await this.sendMessagePayload(text, attachments, displayText, true);
            },

            async sendMessagePayload(text, attachments, displayText, restoreComposer, replaceFromMessageId = null) {
                const outgoingAttachments = Array.isArray(attachments) ? attachments.map(attachment => ({ ...attachment })) : [];
                if ((!text && outgoingAttachments.length === 0) || this.isLoading) return;
                if (!this.validateOutgoingAttachmentBudget(outgoingAttachments)) return;
                if (this.humanSupportActive) this.stopSupportTyping();

                const cleanText = text.trim();
                const defaultSingleImage = typeof this.t === 'function' ? this.t('sent_an_image') : (typeof window.$t === 'function' ? window.$t('Sent an image') : 'Sent an image');
                const defaultMultiImages = typeof this.t === 'function' ? this.t('sent_images_count', { 1: outgoingAttachments.length }) : (typeof window.$t === 'function' ? window.$t('Sent %1 images').replace('%1', outgoingAttachments.length) : `Sent ${outgoingAttachments.length} images`);
                const fallbackImagesText = outgoingAttachments.length > 1 ? defaultMultiImages : defaultSingleImage;
                const visibleText = displayText || (cleanText || fallbackImagesText);

                if (restoreComposer) {
                    this.userInput = '';
                    this.imageAttachments = [];
                    this.uploadError = '';
                    this.resetComposerInput();
                    this.$nextTick(() => this.resetComposerInput());
                }

                this.hasStartedChat = true;
                this.isCreatingNewChat = false;
                const requestId = this.createRequestId();
                this.messages.push({
                    role: 'user',
                    content: visibleText,
                    request_id: requestId,
                    mutationBusy: false,
                    attachments: outgoingAttachments.map((attachment) => ({
                        name: attachment.name,
                        size: attachment.size,
                        type: attachment.type,
                        previewUrl: attachment.previewUrl
                    }))
                });
                this.scheduleGuestSessionSnapshot();
                this.isLoading = true;
                this.responseStartedAt = Date.now();
                this.activeRequestId = requestId;
                delete this.cancelledRequestIds[requestId];
                this.statusMessage = '';
                this.currentAiMessageIndex = -1;
                this.pendingProductParts = [];
                this.pendingOrderAddressFormParts = [];
                this.pendingGuestOrderAccessParts = [];
                this.thinkingEvents = [];
                this.thinkingSteps = [];
                this.toolActivities = [];
                this.armResponseWatchdog();
                // Start the new customer turn at the top of the reading
                // region, like Codex. The shell switches to bottom-following
                // only once this turn becomes taller than the available area.
                this.isTurnStartPinned = true;
                this.pinnedTurnRequestId = requestId;
                this.$nextTick(() => {
                    this.pinCurrentTurnToTop?.(requestId);
                    // A status/tool frame can race Alpine's first DOM paint.
                    // Align once more after layout so the submitted bubble is
                    // never left in the lower part of the scroll viewport.
                    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                        window.requestAnimationFrame(() => this.pinCurrentTurnToTop?.(requestId));
                    }
                });
                let outgoingUserParts;
                try {
                    outgoingUserParts = typeof this.prepareOutgoingUserParts === 'function'
                        ? await this.prepareOutgoingUserParts(cleanText, outgoingAttachments)
                        : this.buildOutgoingUserParts(cleanText, outgoingAttachments);
                } catch (uploadError) {
                    this.messages.pop();
                    this.hasStartedChat = this.messages.length > 0;
                    this.isLoading = false;
                    this.activeRequestId = null;
                    this.responseStartedAt = 0;
                    this.uploadError = this.uploadError || 'Attachment upload failed. Please try again.';
                    return;
                }

                const sentUserMessage = this.messages[this.messages.length - 1];
                if (sentUserMessage && Array.isArray(sentUserMessage.attachments)) {
                    sentUserMessage.attachments.forEach((att, idx) => {
                        const sourceAtt = outgoingAttachments[idx];
                        if (sourceAtt?.attachment_id) {
                            att.attachment_id = sourceAtt.attachment_id;
                            att.previewUrl = `/afd_ai/chat/attachment?id=${encodeURIComponent(sourceAtt.attachment_id)}`;
                        }
                    });
                }
                this.scheduleGuestSessionSnapshot();
                const history = this.buildModelHistory();
                const guestHistory = this.isLoggedIn ? [] : this.buildGuestHistorySnapshot();
                const chatPayload = {
                    action: 'chat',
                    request_id: requestId,
                    text: visibleText,
                    parts: outgoingUserParts,
                    // Binary content is transported once in `parts`.
                    // `images` contains bounded display metadata only.
                    images: outgoingAttachments.map((attachment) => ({
                        name: attachment.name,
                        type: attachment.type,
                        size: attachment.size
                    })),
                    history,
                    guest_history: guestHistory,
                    conversation_id: this.activeConversationId,
                    // Editing/regenerating replaces the old branch in
                    // Magento as well as in the visible transcript.
                    replace_from_message_id: Number(replaceFromMessageId) || null
                };
                const serializedChatPayload = JSON.stringify(chatPayload);

                if (utf8ByteLength(serializedChatPayload) > MAX_WEBSOCKET_PAYLOAD_BYTES) {
                    this.messages.pop();
                    this.hasStartedChat = this.messages.length > 0;
                    this.isLoading = false;
                    this.activeRequestId = null;
                    this.responseStartedAt = 0;
                    this.currentAiMessageIndex = -1;
                    this.pendingProductParts = [];
                    this.pendingOrderAddressFormParts = [];
                    this.pendingGuestOrderAccessParts = [];
                    this.clearResponseWatchdog();
                    this.userInput = cleanText;
                    this.imageAttachments = outgoingAttachments;
                    this.uploadError = 'This message is too large for the secure chat connection. Remove an image or shorten the message/history and try again.';
                    this.$nextTick(() => this.resizeComposerInput?.());
                    return;
                }

                if (this.activeConversationId) {
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 180);
                }

                if (!this.socket || !this.wsConnected) {
                    await this.connectWebSocket();
                    await this.waitForSecureSocket();
                }

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(serializedChatPayload);
                        return;
                    } catch (socketError) {
                        this.wsConnected = false;
                    }
                }

                this.messages.pop();
                this.hasStartedChat = this.messages.length > 0;
                this.isLoading = false;
                this.activeRequestId = null;
                this.responseStartedAt = 0;
                this.clearResponseWatchdog();
                if (restoreComposer) {
                    this.userInput = cleanText;
                    this.imageAttachments = outgoingAttachments;
                    this.$nextTick(() => this.resizeComposerInput());
                }
                this.setTransportNotice(
                    'secure-gateway-unavailable',
                    'Secure AI gateway unavailable',
                    'The chat service is reconnecting. Please try again in a moment.'
                );
            },

            async waitForSecureSocket(timeoutMs = 3000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeoutMs) {
                    if (this.socket && this.wsConnected) return true;
                    await new Promise(resolve => window.setTimeout(resolve, 50));
                }
                return false;
            },

            createRequestId() {
                return 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
            },

            shouldIgnoreStreamMessage(data) {
                if (!data) return false;
                // `message_saved` is an asynchronous persistence acknowledgement.
                // It may arrive after `done` (or while the shopper has already
                // started the next turn), so it must still be allowed to attach
                // the durable message id to the visible response.
                if (data.type === 'message_saved') return false;

                // Product pagination is an independent, signed request. Its
                // response intentionally has no chat request_id, because it
                // must not reopen or mutate the active assistant turn. Do not
                // classify these frames as stale lifecycle events; otherwise
                // the button remains stuck on "Loading products…" forever.
                if (data.type === 'products_page' || data.type === 'product_page_error') return false;

                const requestId = String(data.request_id || '');
                if (requestId && this.cancelledRequestIds[requestId]) return true;

                // Lifecycle frames must always belong to a specific customer
                // turn. A queued frame from an older gateway can arrive with
                // no request id while a newer turn is active; accepting it
                // would append the previous answer to the new one.
                if (!requestId && !this.activeRequestId) {
                    return this.isResponseLifecycleMessage(data.type);
                }

                if (this.activeRequestId) {
                    return !requestId
                        ? this.isResponseLifecycleMessage(data.type)
                        : requestId !== this.activeRequestId;
                }

                // A WebSocket can already have queued status/tool frames when
                // the final `done` frame closes a turn. Without this guard a
                // late `status` or `tool_activity` resurrects `isLoading`, which
                // leaves the composer showing Stop even though the answer is
                // complete. Non-stream events (cart updates and persistence
                // acknowledgements) remain processable.
                return this.isResponseLifecycleMessage(data.type);
            },

            isResponseLifecycleMessage(type) {
                return [
                    'stream_reset',
                    'discard_thinking_text',
                    'thinking_delta',
                    'discard_tentative_step',
                    'thinking_step',
                    'chunk',
                    'tool_activity',
                    'image_generation_started',
                    'image_generated',
                    'image_generation_failed',
                    'products_html',
                    'products_page',
                    'product_page_error',
                    'guest_order_access_required',
                    'order_address_form',
                    'status',
                    'busy',
                    'error',
                    'done',
                    'cancelled'
                ].includes(String(type || ''));
            },

            clearResponseWatchdog() {
                if (this.responseWatchdogTimer) {
                    window.clearTimeout(this.responseWatchdogTimer);
                    this.responseWatchdogTimer = null;
                }
            },

            armResponseWatchdog() {
                this.clearResponseWatchdog();
                if (!this.isLoading || !this.activeRequestId) return;

                this.responseWatchdogTimer = window.setTimeout(() => {
                    if (!this.isLoading || !this.activeRequestId) return;
                    this.stopCurrentResponse();
                    this.setTransportNotice(
                        'response-timeout',
                        'Response timed out',
                        'The AI response took too long. Please try again.'
                    );
                }, 125000);
            },

            handleActiveRequestDisconnect() {
                if (!this.isLoading || !this.activeRequestId) return;

                this.clearResponseWatchdog();
                this.finalizeStreamingMarkdown();
                this.isLoading = false;
                this.statusMessage = '';
                this.currentAiMessageIndex = -1;
                this.pendingProductParts = [];
                this.pendingOrderAddressFormParts = [];
                this.pendingGuestOrderAccessParts = [];
                this.activeRequestId = null;
                this.responseStartedAt = 0;
                this.setTransportNotice(
                    'response-interrupted',
                    'Response interrupted',
                    'The secure chat connection was interrupted. Please retry your message.'
                );
            },

            recordInterruptedResponse(stoppedAfterSeconds = null) {
                const elapsed = stoppedAfterSeconds === null
                    ? Math.max(0, Math.floor((Date.now() - (this.responseStartedAt || Date.now())) / 1000))
                    : Math.max(0, Math.floor(Number(stoppedAfterSeconds) || 0));
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant') {
                    message = { role: 'assistant', feedbackEnabled: false, feedbackBusy: false, parts: [] };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                this.finalizeStreamingMarkdown();
                message.interrupted = true;
                message.stoppedAfterSeconds = elapsed;
                this.scheduleGuestSessionSnapshot();
                this.scheduleCrossTabConversationSync(this.activeConversationId, 80);
                this.$nextTick(() => this.scrollToBottom());
            },

            stoppedResponseLabel(message) {
                const seconds = Math.max(0, Number(message?.stoppedAfterSeconds) || 0);
                if (typeof this.t === 'function') {
                    return this.t('you_stopped_after', { 1: seconds });
                }
                return `You stopped after ${seconds}s`;
            },

            continueStoppedResponse() {
                if (this.isLoading || this.isReadingAttachments) return;

                let lastAssistantIndex = -1;
                for (let i = this.messages.length - 1; i >= 0; i--) {
                    if (this.messages[i]?.role === 'assistant') {
                        lastAssistantIndex = i;
                        break;
                    }
                }
                if (lastAssistantIndex < 0) return;

                const targetMessage = this.messages[lastAssistantIndex];
                targetMessage.interrupted = false;
                targetMessage.stoppedAfterSeconds = null;

                this.currentAiMessageIndex = lastAssistantIndex;
                this.isLoading = true;
                this.statusMessage = '';
                this.responseStartedAt = Date.now();
                this.thinkingEvents = [];
                this.toolActivities = [];

                const requestId = this.createRequestId();
                this.activeRequestId = requestId;
                this.armResponseWatchdog();

                const history = this.buildModelHistory();
                const continuationPrompt = 'Continue your previous response from where you stopped. Continue naturally in the same language without repeating what was already written.';

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'chat',
                            request_id: requestId,
                            conversation_id: this.activeConversationId,
                            is_continuation: true,
                            text: continuationPrompt,
                            parts: [{ text: continuationPrompt }],
                            history: history,
                            images: []
                        }));
                    } catch (e) {
                        this.isLoading = false;
                        this.currentAiMessageIndex = -1;
                        this.clearResponseWatchdog();
                    }
                }
                this.scheduleGuestSessionSnapshot();
                this.scrollToBottom();
            },

            stopCurrentResponse() {
                if (!this.isLoading && this.currentAiMessageIndex === -1) return;

                const requestId = this.activeRequestId;
                if (requestId) {
                    this.cancelledRequestIds = {
                        ...this.cancelledRequestIds,
                        [requestId]: true
                    };
                }

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'cancel_chat',
                            request_id: requestId
                        }));
                    } catch (e) {}
                }

                this.recordInterruptedResponse();
                this.isLoading = false;
                this.statusMessage = '';
                this.currentAiMessageIndex = -1;
                this.pendingProductParts = [];
                this.pendingOrderAddressFormParts = [];
                this.pendingGuestOrderAccessParts = [];
                this.activeRequestId = null;
                this.responseStartedAt = 0;
                this.clearResponseWatchdog();
            },

            async mutateBrowserCart(data) {
                const cartRequestId = String(data?.cart_request_id || '');
                const requestId = String(data?.request_id || '');
                const conversationId = Math.max(0, Number(data?.conversation_id) || 0);
                const analyticsEventId = String(data?.analytics_event_id || '');
                const cart = data?.cart && typeof data.cart === 'object' ? data.cart : {};
                let result;

                try {
                    const response = await fetch(urls.addToCart, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-Form-Key': getBrowserFormKey()
                        },
                        body: JSON.stringify({
                            action: String(cart.action || '') === 'remove' ? 'remove' : 'add',
                            sku: String(cart.sku || ''),
                            qty: Number(cart.qty) || 1,
                            useDefaultQty: cart.useDefaultQty === true,
                            cartTarget: String(cart.cartTarget || '') === 'quote' ? 'quote' : 'checkout',
                            conversationId,
                            analyticsEventId,
                            selectedOptions: cart.selectedOptions && typeof cart.selectedOptions === 'object'
                                ? cart.selectedOptions
                                : {}
                        })
                    });
                    result = await response.json();
                    if (!response.ok && (!result || typeof result !== 'object')) {
                        result = { status: 'error', message: 'The cart request could not be completed.' };
                    }
                } catch (error) {
                    result = {
                        status: 'error',
                        message: 'The cart request could not be completed. Please try again.'
                    };
                }

                if (result?.status === 'success') {
                    window.dispatchEvent(new CustomEvent('reload-customer-section-data'));
                }

                if (this.socket && this.wsConnected && cartRequestId) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'cart_mutation_result',
                            request_id: requestId,
                            cart_request_id: cartRequestId,
                            result: result && typeof result === 'object'
                                ? result
                                : { status: 'error', message: 'The cart returned an invalid response.' }
                        }));
                    } catch (error) {}
                }
            },

            handleStreamMessage(data) {
                if (this.shouldIgnoreStreamMessage(data)) return;

                if (data.type === 'message_saved') {
                    const entityId = Number(data.entity_id) || null;
                    if (data.role === 'user' && entityId) {
                        const savedMessage = [...this.messages].reverse().find((message) => (
                            message?.role === 'user'
                            && String(message.request_id || '') === String(data.request_id || '')
                        ));
                        if (savedMessage) {
                            savedMessage.entity_id = entityId;
                            this.scheduleGuestSessionSnapshot();
                            // Persist the durable entity id immediately. A
                            // browser reload between the response and a
                            // debounced snapshot must not restore this turn as
                            // an anonymous transient duplicate.
                            this.persistGuestSessionSnapshot?.();
                        }
                    } else if (data.role === 'assistant' && entityId) {
                        const savedMessage = [...this.messages].reverse().find((message) => (
                            message?.role === 'assistant'
                            && !message.entity_id
                            && (!data.request_id || !message.request_id || String(message.request_id) === String(data.request_id))
                        ));
                        if (savedMessage) {
                            savedMessage.entity_id = entityId;
                            savedMessage.feedbackEnabled = data.persistent === true;
                            // Regeneration creates a new persisted assistant
                            // message. It must never inherit an in-flight
                            // feedback state from the response it replaced.
                            savedMessage.feedbackBusy = false;
                            this.scheduleGuestSessionSnapshot();
                            this.persistGuestSessionSnapshot?.();
                        }
                    }
                    return;
                }

                if (['chunk', 'thinking_delta', 'thinking_step', 'products_html', 'products_page', 'status', 'tool_activity', 'image_generation_started', 'image_generated', 'image_generation_failed', 'guest_order_access_required'].includes(data.type)) {
                    this.armResponseWatchdog();
                }

                if (data.type === 'conversation_id') {
                    // Received new conversation_id from server
                    this.activeConversationId = data.conversation_id;
                    this.isCreatingNewChat = false;
                    // Refresh conversations list in sidebar
                    if (this.hasConversationHistory) {
                        this.loadConversations();
                    }
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 180);
                    this.scheduleGuestSessionSnapshot();

                } else if (data.type === 'stream_reset') {
                    // Compatibility for a rolling deploy with an older gateway:
                    // never delete customer-visible text. New gateways use the
                    // explicit discard_thinking_text event for tool narration.

                } else if (data.type === 'discard_thinking_text') {
                    this.discardThinkingText();

                } else if (data.type === 'thinking_delta') {
                    this.appendProviderReasoningDelta(data);
                    this.markReasoningResumed?.();
                    this.syncLiveReasoningPart?.();

                } else if (data.type === 'discard_tentative_step') {
                    this.discardProviderReasoningStep(data);
                    this.syncLiveReasoningPart?.();

                } else if (data.type === 'thinking_step') {
                    this.appendProviderReasoningDelta(data);
                    this.markReasoningResumed?.();
                    this.syncLiveReasoningPart?.();

                } else if (data.type === 'chunk') {
                    this.statusMessage = '';
                    // A text delta is not a terminal signal. Providers can
                    // emit provisional prose while a tool call is still in
                    // flight, and Gemini can interleave text/thought parts in
                    // the same response. Keep the live Thinking timeline
                    // mounted until `done`, `error`, or `cancelled`.
                    if (this.currentAiMessageIndex === -1) {
                        const parts = [];
                        if ((Array.isArray(this.thinkingEvents) && this.thinkingEvents.some(event => event?.type === 'activity'
                            || this.isVisibleReasoningEvent(event)))
                            || (Array.isArray(this.toolActivities) && this.toolActivities.length > 0)) {
                            parts.push({
                                id: 'reasoning-' + Date.now(),
                                type: 'reasoning',
                                events: Array.isArray(this.thinkingEvents)
                                    ? this.thinkingEvents.filter(event => event?.type === 'activity'
                                        || this.isVisibleReasoningEvent(event))
                                    : [],
                                steps: Array.isArray(this.thinkingEvents)
                                    ? this.thinkingEvents.filter(event => this.isProviderReasoningStep(event))
                                    : [],
                                activities: Array.isArray(this.toolActivities) ? [...this.toolActivities] : [],
                                startedAt: this.responseStartedAt || Date.now(),
                                isManuallyCollapsed: false,
                                isExpanded: true
                            });
                        }
                        parts.push(this.createStreamingTextPart(data.content || ''));
                        this.messages.push({
                            role: 'assistant',
                            request_id: data.request_id || this.activeRequestId || '',
                            feedbackEnabled: false,
                            feedbackBusy: false,
                            parts
                        });
                        this.currentAiMessageIndex = this.messages.length - 1;
                    } else {
                        const msg = this.messages[this.currentAiMessageIndex];
                        if (msg) {
                            if (((Array.isArray(this.thinkingEvents) && this.thinkingEvents.some(event => event?.type === 'activity'
                                || this.isVisibleReasoningEvent(event)))
                                || (Array.isArray(this.toolActivities) && this.toolActivities.length > 0))
                                && !msg.parts.some(p => p?.type === 'reasoning')) {
                                msg.parts.unshift({
                                    id: 'reasoning-' + Date.now(),
                                    type: 'reasoning',
                                    events: Array.isArray(this.thinkingEvents)
                                        ? this.thinkingEvents.filter(event => event?.type === 'activity'
                                            || this.isVisibleReasoningEvent(event))
                                        : [],
                                    steps: Array.isArray(this.thinkingEvents)
                                        ? this.thinkingEvents.filter(event => this.isProviderReasoningStep(event))
                                        : [],
                                    activities: Array.isArray(this.toolActivities) ? [...this.toolActivities] : [],
                                    startedAt: this.responseStartedAt || Date.now(),
                                    isManuallyCollapsed: false,
                                    isExpanded: true
                                });
                            }
                            let lastPart = msg.parts[msg.parts.length - 1];
                            if (!lastPart || lastPart.type !== 'text') {
                                msg.parts.push(this.createStreamingTextPart());
                                lastPart = msg.parts[msg.parts.length - 1];
                            }
                            this.appendStreamingText(lastPart, data.content || '');
                        }
                    }
                    // Codex-style handoff: the moment answer text starts, the
                    // live Thinking section folds to a static "Thought for
                    // Ns" header. Later thinking/tool events re-open it via
                    // `markReasoningResumed`; a manual toggle always wins.
                    const liveReasoning = this.currentLiveReasoningPart();
                    if (liveReasoning
                        && liveReasoning.isManuallyCollapsed !== true
                        && liveReasoning.wasManuallyToggled !== true) {
                        this.freezeReasoningElapsed(liveReasoning);
                        liveReasoning.autoCollapsed = true;
                        liveReasoning.isExpanded = false;
                    }
                    // Streaming snapshots are durability checkpoints, not a
                    // per-frame render concern. The final `done` event still
                    // persists immediately.
                    this.scheduleGuestSessionSnapshot(900);

                } else if (data.type === 'tool_activity') {
                    const activityId = String(data.activity_id || 'tool-' + Date.now() + '-' + Math.random());
                    const nextState = ['running', 'completed', 'failed'].includes(data.state) ? data.state : 'running';
                    const now = Date.now();
                    // Some gateway/provider combinations publish the next
                    // tool's `running` frame before explicitly closing the
                    // previous one. The UI is a serial work timeline: once a
                    // new action starts, freeze every older running row so it
                    // stops shimmering and its elapsed time no longer ticks.
                    if (nextState === 'running') {
                        const completePreviousActivity = (activity) => {
                            if (activity?.type !== 'activity' || activity.id === activityId) {
                                return activity;
                            }
                            // State can be completed before the assistant turn
                            // is done, so keep a separate live-action marker.
                            const noLongerCurrent = {
                                ...activity,
                                isCurrentAction: false
                            };
                            return activity.state === 'running'
                                ? {
                                    ...noLongerCurrent,
                                    state: 'completed',
                                    completedAt: Number(activity.completedAt) || now
                                }
                                : noLongerCurrent;
                        };
                        if (Array.isArray(this.thinkingEvents)) {
                            this.thinkingEvents = this.thinkingEvents.map(completePreviousActivity);
                        }
                        if (Array.isArray(this.toolActivities)) {
                            this.toolActivities = this.toolActivities.map(completePreviousActivity);
                        }
                    }
                    const existingEvent = Array.isArray(this.thinkingEvents)
                        ? this.thinkingEvents.find(item => item.type === 'activity' && item.id === activityId)
                        : null;
                    const nextActivity = {
                        id: activityId,
                        type: 'activity',
                        tool: String(data.tool || ''),
                        state: nextState,
                        result_count: Number.isFinite(Number(data.result_count)) ? Number(data.result_count) : null,
                        // Client-side timestamps drive the Codex-style
                        // "… for Ns" labels; the protocol carries states only.
                        startedAt: Number(existingEvent?.startedAt) || now,
                        completedAt: nextState === 'running'
                            ? (Number(existingEvent?.completedAt) || null)
                            : (Number(existingEvent?.completedAt) || now),
                        // The current action keeps shimmering until a newer
                        // action starts or the whole assistant turn completes.
                        isCurrentAction: nextState === 'running'
                            ? true
                            : existingEvent?.isCurrentAction !== false
                    };
                    this.markReasoningResumed?.();
                    if (!Array.isArray(this.thinkingEvents)) this.thinkingEvents = [];
                    const eventIndex = this.thinkingEvents.findIndex(item => item.type === 'activity' && item.id === activityId);
                    if (eventIndex === -1) {
                        this.thinkingEvents.push(nextActivity);
                    } else {
                        this.thinkingEvents.splice(eventIndex, 1, {
                            ...this.thinkingEvents[eventIndex],
                            ...nextActivity
                        });
                    }

                    const activityIndex = this.toolActivities.findIndex(activity => activity.id === activityId);
                    if (activityIndex === -1) {
                        this.toolActivities.push(nextActivity);
                    } else {
                        this.toolActivities.splice(activityIndex, 1, {
                            ...this.toolActivities[activityIndex],
                            ...nextActivity
                        });
                    }

                    this.syncLiveReasoningPart?.();

                    // A tool action belongs to the current assistant turn.
                    // Keeping its cursor intact means a later final chunk and
                    // the selected product grid stay in one response rather
                    // than becoming two visually independent answers.
                    this.statusMessage = this.toolActivityLabel(nextActivity);
                    this.isLoading = true;
                    this.scrollToBottom();

                } else if (data.type === 'image_generation_started') {
                    this.imageGenerationNow = Date.now();
                    this.upsertGeneratedImagePart({
                        ...data,
                        started_at: Date.now()
                    }, 'generating');
                    this.statusMessage = 'Generating image';
                    this.isLoading = true;
                    this.scheduleGuestSessionSnapshot();
                    this.scrollToBottom();

                } else if (data.type === 'image_generated') {
                    this.upsertGeneratedImagePart(data, 'complete');
                    this.statusMessage = 'Image ready';
                    this.scheduleGuestSessionSnapshot();
                    this.scrollToBottom();

                } else if (data.type === 'image_generation_failed') {
                    this.upsertGeneratedImagePart(data, 'error');
                    this.statusMessage = '';
                    this.scheduleGuestSessionSnapshot();
                    this.scrollToBottom();

                } else if (data.type === 'products_html') {
                    const incoming = {
                        id: Date.now() + Math.random(),
                        type: 'products',
                        html: hydrateProductGridHtml(data.html),
                        payload: data.products || null
                    };
                    // Tool searches are internal retrieval attempts. During a
                    // rolling deploy an older gateway may still emit several;
                    // retain only the final accepted presentation for the turn.
                    this.pendingProductParts = [incoming];

                } else if (data.type === 'products_page') {
                    this.appendProductPage(data);

                } else if (data.type === 'product_page_error') {
                    this.completeProductPageRequest(data.product_part_id);
                    this.setTransportNotice(
                        'catalog-page-failed',
                        typeof this.t === 'function' ? this.t('catalog_page_failed_title') : 'More products could not be loaded',
                        data.content || (typeof this.t === 'function'
                            ? this.t('catalog_page_failed_copy')
                            : 'Could not load more products. Please try again.')
                    );

                } else if (data.type === 'cart_updated') {
                    // Hyva refreshes its customer-data sections (including the
                    // header/minicart) without disturbing the open chat.
                    window.dispatchEvent(new CustomEvent('reload-customer-section-data'));

                } else if (data.type === 'cart_add_request' || data.type === 'cart_remove_request') {
                    this.mutateBrowserCart(data);

                } else if (data.type === 'guest_order_access_required') {
                    this.statusMessage = '';
                    if (data.purpose !== 'support') {
                        this.applyGuestOrderAccessState(data.state === 'verified' ? 'verified' : 'email');
                        if (typeof this.broadcastCrossTabEvent === 'function') {
                            this.broadcastCrossTabEvent('guest_order_access_state', {
                                state: data.state === 'verified' ? 'verified' : 'email'
                            });
                        }
                    }
                    // Queue the secure card until the final text and `done`
                    // event arrive. All custom HTML must follow the complete
                    // customer-facing message, never interrupt its stream.
                    this.pendingGuestOrderAccessParts.push({
                        ...data,
                        content: ''
                    });

                } else if (data.type === 'order_address_form') {
                    this.statusMessage = '';
                    const formId = String(data.form_id || '');
                    const alreadyQueued = this.pendingOrderAddressFormParts.some(
                        part => formId && String(part?.form_id || '') === formId
                    );
                    if (!alreadyQueued) {
                        this.pendingOrderAddressFormParts.push(data);
                    }

                } else if (data.type === 'order_address_update_result') {
                    const part = this.findOrderAddressForm(data.form_id);
                    if (!part) return;
                    const result = data.result || {};
                    part.busy = false;
                    if (result.status === 'success') {
                        part.status = part.resourceType === 'customer_account' ? 'editing' : 'success';
                        part.address = this.normalizeOrderAddressFormValue(result.address || part.address);
                        part.addresses[part.addressType] = this.normalizeOrderAddressFormValue(result.address || part.address);
                        part.notice = String(result.message || (part.resourceType === 'customer_account'
                            ? 'Your default account address was updated.'
                            : 'The order address was updated.'));
                        part.noticeVariant = 'success';
                    } else {
                        part.notice = String(result.message || (part.resourceType === 'customer_account'
                            ? 'Your account address could not be updated.'
                            : 'The order address could not be updated.'));
                        part.noticeVariant = 'error';
                        if (['guest_access_required', 'guest_reverification_required'].includes(String(result.reason || ''))) {
                            part.status = 'verification_required';
                        }
                    }
                    this.$nextTick(() => this.scrollToBottom());

                } else if (data.type === 'guest_order_otp_result') {
                    const part = this.findGuestOrderAccessPart(data.form_id) || this.findLatestSupportAccessPart() || this.findPendingGuestOrderAccessPart();
                    if (!part) return;
                    part.busy = false;
                    part.notice = String(data.result?.message || 'Check your email for the verification code.');
                    if (data.result?.status === 'success') {
                        part.noticeVariant = 'neutral';
                        part.state = 'code';
                        // Magento OTP challenges are valid for ten minutes from
                        // the moment the code is sent. Restart the visible timer
                        // so it reflects the server-side challenge accurately.
                        part.expiresAt = Date.now() + (10 * 60 * 1000);
                        this.scheduleGuestOrderAccessFormExpiry(part);
                    } else {
                        part.noticeVariant = 'error';
                        part.state = 'email';
                    }
                    this.scheduleGuestSessionSnapshot();

                } else if (data.type === 'guest_order_verify_result') {
                    const part = this.findGuestOrderAccessPart(data.form_id) || this.findPendingGuestOrderAccessPart();
                    if (!part) return;
                    part.busy = false;
                    if (data.result?.status === 'success') {
                        if (data.purpose === 'support' || part.purpose === 'support') {
                            const verifiedUntil = this.normalizeGuestOrderAccessExpiry(data.result?.expires_at);
                            this.messages.forEach((message) => {
                                (Array.isArray(message?.parts) ? message.parts : []).forEach((candidate) => {
                                    if (candidate?.type !== 'guest_order_access' || candidate.purpose !== 'support') return;
                                    if (candidate.expiryTimer) {
                                        window.clearInterval(candidate.expiryTimer);
                                        candidate.expiryTimer = null;
                                    }
                                    candidate.state = 'verified';
                                    candidate.expiresAt = verifiedUntil;
                                    candidate.remainingSeconds = 0;
                                    candidate.busy = false;
                                    candidate.code = '';
                                    candidate.notice = candidate === part ? 'Email verified. Continuing your request…' : '';
                                    candidate.noticeVariant = 'success';
                                });
                            });
                        } else {
                            this.applyGuestOrderAccessState('verified', data.result?.expires_at);
                            if (typeof this.broadcastCrossTabEvent === 'function') {
                                this.broadcastCrossTabEvent('guest_order_access_state', {
                                    state: 'verified',
                                    expires_at: data.result?.expires_at
                                });
                            }
                        }
                    } else {
                        part.notice = String(data.result?.message || 'That code could not be verified.');
                        part.noticeVariant = 'error';
                        part.state = 'code';
                    }
                    this.scheduleGuestSessionSnapshot();

                } else if (data.type === 'verification_action_resuming') {
                    const part = this.findGuestOrderAccessPart(data.form_id) || this.findPendingGuestOrderAccessPart();
                    if (part) {
                        part.busy = true;
                        part.state = 'verified';
                        part.notice = String(data.content || 'Email verified. Continuing your request…');
                        part.noticeVariant = 'success';
                    }
                    this.activeRequestId = String(data.request_id || this.createRequestId());
                    this.isLoading = true;
                    this.responseStartedAt = Date.now();
                    this.currentAiMessageIndex = -1;
                    this.statusMessage = String(data.content || 'Continuing your request');
                    this.toolActivities = [];
                    this.armResponseWatchdog();
                    this.scheduleGuestSessionSnapshot();
                    this.scrollToBottom();

                } else if (data.type === 'support_portal_result') {
                    const part = this.findGuestOrderAccessPart(data.form_id) || this.findLatestSupportAccessPart() || this.findPendingGuestOrderAccessPart();
                    if (!part) return;
                    const result = data.result || {};
                    part.portalLoading = false;
                    part.busy = false;
                    if (result.status === 'success') {
                        const tickets = Array.isArray(result.cases) ? result.cases : [];
                        this.messages.forEach((message) => {
                            (Array.isArray(message?.parts) ? message.parts : []).forEach((candidate) => {
                                if (candidate?.type !== 'guest_order_access' || candidate.purpose !== 'support') return;
                                if (candidate.expiryTimer) {
                                    window.clearInterval(candidate.expiryTimer);
                                    candidate.expiryTimer = null;
                                }
                                candidate.state = 'verified';
                                candidate.remainingSeconds = 0;
                                candidate.portalLoading = false;
                                candidate.busy = false;
                                candidate.tickets = tickets;
                                candidate.notice = '';
                                candidate.noticeVariant = 'success';
                            });
                        });
                    } else {
                        part.notice = String(result.message || 'Your support tickets could not be loaded.');
                        part.noticeVariant = 'error';
                    }
                    this.scheduleGuestSessionSnapshot();
                    this.$nextTick(() => this.scrollToBottom());

                } else if (data.type === 'support_ticket_create_result') {
                    const part = this.findGuestOrderAccessPart(data.form_id) || this.findLatestSupportAccessPart() || this.findPendingGuestOrderAccessPart();
                    if (!part) return;
                    const result = data.result || {};
                    part.busy = false;
                    if (result.status === 'success' && result.case?.conversation_id) {
                        part.ticketFormOpen = false;
                        part.notice = String(result.message || 'Your support ticket was created.');
                        part.noticeVariant = 'success';
                        const conversationId = Number(result.case.conversation_id);
                        window.setTimeout(() => this.refreshSupportConversation(conversationId), 0);
                    } else {
                        part.notice = String(result.message || 'The support ticket could not be created.');
                        part.noticeVariant = 'error';
                    }
                    this.$nextTick(() => this.scrollToBottom());

                } else if (data.type === 'error') {
                    this.statusMessage = '';
                    this.collapseReasoningForAnswer?.();
                    this.finalizeStreamingMarkdown();
                    this.isLoading = false;
                    this.activeRequestId = null;
                    this.responseStartedAt = 0;
                    this.pendingProductParts = [];
                    this.pendingOrderAddressFormParts = [];
                    this.pendingGuestOrderAccessParts = [];
                    this.clearResponseWatchdog();
                    this.messages.push({
                        role: 'assistant',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: [{
                            id: Date.now(),
                            type: 'text',
                            raw: '',
                            html: '<div class="afd-ai-chat__error-card"><p class="afd-ai-chat__error-title">AI service error</p><p class="afd-ai-chat__error-text">' + escapeHtml(data.content || 'The AI service is unavailable.') + '</p></div>'
                        }]
                    });
                    this.scrollToBottom();

                } else if (data.type === 'busy') {
                    // Admission control rejects this turn before an adapter can
                    // emit `done`. Treat it as a terminal event so the composer
                    // immediately returns from Stop to Send.
                    this.collapseReasoningForAnswer?.();
                    this.finalizeStreamingMarkdown();
                    this.isLoading = false;
                    this.statusMessage = '';
                    this.currentAiMessageIndex = -1;
                    this.activeRequestId = null;
                    this.responseStartedAt = 0;
                    this.pendingProductParts = [];
                    this.pendingOrderAddressFormParts = [];
                    this.pendingGuestOrderAccessParts = [];
                    this.clearResponseWatchdog();
                    this.setTransportNotice?.(
                        'ai-service-busy',
                        'AI service is busy',
                        data.content || 'The AI service is busy. Please try again shortly.'
                    );
                    this.scrollToBottom();

                } else if (data.type === 'status') {
                    this.statusMessage = this.normalizeStatusMessage(data.content);
                    this.isLoading = true;

                } else if (data.type === 'done') {
                    const completedRequestId = String(data.request_id || this.activeRequestId || '');
                    // Codex closes a turn with a "Worked for Ns" marker; the
                    // elapsed time must be captured before the turn state
                    // resets below.
                    const completedMessage = this.currentAiMessageIndex >= 0
                        ? this.messages[this.currentAiMessageIndex]
                        : null;
                    if (completedMessage && completedMessage.role === 'assistant' && this.responseStartedAt) {
                        completedMessage.workedForMs = Math.max(0, Date.now() - this.responseStartedAt);
                    }
                    this.finalizeStreamingMarkdown();
                    this.flushPendingReasoningParts();
                    this.flushPendingProductParts();
                    this.flushPendingOrderAddressFormParts();
                    this.flushPendingGuestOrderAccessParts();
                    this.isLoading = false;
                    this.statusMessage = '';
                    this.currentAiMessageIndex = -1;
                    this.activeRequestId = null;
                    this.responseStartedAt = 0;
                    this.clearResponseWatchdog();
                    // Rating transport state is unrelated to response
                    // generation. A completed turn must always be interactive.
                    this.messages.forEach((message) => {
                        if (message?.role !== 'assistant') return;
                        if (!completedRequestId
                            || String(message.request_id || '') !== completedRequestId) return;
                        message.feedbackBusy = false;
                        if (data.provider_meta && typeof data.provider_meta === 'object') {
                            message.provider_meta = data.provider_meta;
                        }
                    });
                    if (data.request_id) {
                        delete this.cancelledRequestIds[data.request_id];
                    }
                    this.scheduleGuestSessionSnapshot();
                    this.$nextTick(() => {
                        // `scrollToBottom()` owns all follow-up placement. It
                        // preserves the pinned customer turn when it still
                        // fits, or follows the response once it overflows.
                        // Calling `pinCurrentTurnToTop()` here as well caused
                        // competing placements after the final render.
                        this.scrollToBottom();
                    });
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 360);
                    if (Number(this.pendingSupportConversationId) === Number(this.activeConversationId)) {
                        const conversationId = Number(this.pendingSupportConversationId);
                        this.pendingSupportConversationId = 0;
                        window.setTimeout(() => this.switchConversation(conversationId, true), 0);
                    }

                } else if (data.type === 'cancelled') {
                    this.collapseReasoningForAnswer?.();
                    this.recordInterruptedResponse(data.stopped_after_seconds);
                    this.isLoading = false;
                    this.statusMessage = '';
                    this.currentAiMessageIndex = -1;
                    this.pendingProductParts = [];
                    this.pendingOrderAddressFormParts = [];
                    this.pendingGuestOrderAccessParts = [];
                    this.thinkingEvents = [];
                    this.thinkingSteps = [];
                    this.toolActivities = [];
                    this.responseStartedAt = 0;
                    this.clearResponseWatchdog();
                    if (!data.request_id || data.request_id === this.activeRequestId) {
                        this.activeRequestId = null;
                    }
                }
            },

            flushPendingReasoningParts() {
                const publicEvents = (Array.isArray(this.thinkingEvents) ? this.thinkingEvents : [])
                    .filter(event => event?.type === 'activity'
                        || this.isVisibleReasoningEvent(event));
                const hasEvents = publicEvents.length > 0;
                const hasLegacy = Array.isArray(this.toolActivities) && this.toolActivities.length > 0;
                if (!hasEvents && !hasLegacy) {
                    return;
                }

                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = {
                        role: 'assistant',
                        request_id: this.activeRequestId || '',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: []
                    };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                const reasoningPart = {
                    id: Date.now() + Math.random(),
                    type: 'reasoning',
                    events: publicEvents,
                    steps: publicEvents.filter(event => event?.type === 'step'),
                    activities: [...(this.toolActivities || [])],
                    // Keep the completed reasoning/action timeline visible.
                    // The shopper can collapse it manually from the header;
                    // terminal state alone must not erase the evidence of
                    // which actions were run for this answer.
                    isExpanded: true,
                    isManuallyCollapsed: false
                };

                const existingIndex = message.parts.findIndex(p => p?.type === 'reasoning');
                if (existingIndex === -1) {
                    const reasoningStart = this.responseStartedAt || Date.now();
                    reasoningPart.startedAt = reasoningPart.startedAt || reasoningStart;
                    this.freezeReasoningElapsed(reasoningPart);
                    // Codex collapses the reasoning section as soon as the
                    // turn completes; a manual shopper toggle wins over the
                    // automatic state.
                    reasoningPart.isExpanded = reasoningPart.wasManuallyToggled === true
                        ? reasoningPart.isExpanded
                        : false;
                    reasoningPart.autoCollapsed = true;
                    message.parts.unshift(reasoningPart);
                } else {
                    // Preserve the live part identity and disclosure state so
                    // Alpine does not tear down and rebuild the action DOM at
                    // `done`, which previously caused a visible container jump.
                    const existingPart = message.parts[existingIndex];
                    existingPart.events = reasoningPart.events;
                    existingPart.steps = reasoningPart.steps;
                    existingPart.activities = reasoningPart.activities;
                    this.freezeReasoningElapsed(existingPart);
                    if (existingPart.wasManuallyToggled === true) {
                        if (existingPart.isManuallyCollapsed !== true) {
                            existingPart.isExpanded = true;
                        }
                    } else {
                        // Codex behavior: the completed Thinking section
                        // folds to its "Thought for Ns" header.
                        existingPart.autoCollapsed = true;
                        existingPart.isExpanded = false;
                    }
                }

                this.thinkingEvents = [];
                this.toolActivities = [];
                this.thinkingSteps = [];
            },

            flushPendingProductParts() {
                if (!Array.isArray(this.pendingProductParts) || this.pendingProductParts.length === 0) {
                    return;
                }

                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = {
                        role: 'assistant',
                        request_id: this.activeRequestId || '',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: []
                    };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                this.pendingProductParts.forEach((incoming) => {
                    const existingIndex = message.parts.findIndex(part => part?.type === 'products');
                    if (existingIndex === -1) {
                        message.parts.push(incoming);
                        return;
                    }

                    // The gateway may publish an older candidate during a
                    // rolling deploy, then the final candidate for the same
                    // request. Preserve the existing part id so a pending
                    // pagination action stays associated with this one grid.
                    message.parts.splice(existingIndex, 1, {
                        ...incoming,
                        id: message.parts[existingIndex].id
                    });
                });
                this.pendingProductParts = [];
                this.scheduleGuestSessionSnapshot();
            },

            flushPendingOrderAddressFormParts() {
                if (!Array.isArray(this.pendingOrderAddressFormParts) || this.pendingOrderAddressFormParts.length === 0) {
                    return;
                }

                const pendingForms = this.pendingOrderAddressFormParts;
                this.pendingOrderAddressFormParts = [];
                pendingForms.forEach(form => this.appendOrderAddressForm(form));
            },

            flushPendingGuestOrderAccessParts() {
                if (!Array.isArray(this.pendingGuestOrderAccessParts) || this.pendingGuestOrderAccessParts.length === 0) {
                    return;
                }

                const pendingForms = this.pendingGuestOrderAccessParts;
                this.pendingGuestOrderAccessParts = [];
                pendingForms.forEach(form => this.appendGuestOrderAccessForm(form));
            },

            finalizeStreamingMarkdown() {
                const message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;
                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) return;

                message.feedbackEnabled = true;
                message.parts.forEach(part => {
                    if (part?.type === 'text') {
                        this.finalizeStreamingText(part);
                    }
                });
            },

            discardThinkingText() {
                const index = this.currentAiMessageIndex;
                const message = index >= 0 ? this.messages[index] : null;
                if (!message || message.role !== 'assistant') {
                    return;
                }

                // Older gateways used this frame to retract provisional
                // narration before a tool call. Removing the entire
                // assistant bubble here also removed real Thinking steps and
                // actions, leaving only the later tool status visible. The
                // current protocol has `discard_tentative_step` for the
                // narrow case, so keep all customer-visible evidence when an
                // old frame arrives.
                this.finalizeStreamingMarkdown();
                this.syncLiveReasoningPart?.();
            },

            // ==================== UTILITIES ====================
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
