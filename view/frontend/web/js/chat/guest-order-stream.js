/** Guest order access and support ticket stream methods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.guestOrderStreamMethods = function (context) {
        const { config, urls } = context;
        const {
            sanitizeStreamingHtml,
            getBrowserFormKey,
            resolveWebSocketUrl
        } = context.helpers;

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
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));