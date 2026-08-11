/** streamMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.streamMethods = function (context) {
const { config, urls } = context;
const {
    sanitizeHtml,
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
    MAX_MODEL_HISTORY_MESSAGES
} = context.helpers;

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
                const text = String(data.content || (part.purpose === 'support'
                    ? 'Verify your email before starting human support.'
                    : 'To protect your order information, first verify the email used at checkout.'));
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = {
                        role: 'assistant',
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

            normalizeOrderAddressFormValue(source = {}) {
                const value = source && typeof source === 'object' ? source : {};
                const street = Array.isArray(value.street)
                    ? value.street
                    : String(value.street || '').split(/\r?\n/);
                return {
                    prefix: String(value.prefix || ''),
                    firstname: String(value.firstname || ''),
                    middlename: String(value.middlename || ''),
                    lastname: String(value.lastname || ''),
                    suffix: String(value.suffix || ''),
                    company: String(value.company || ''),
                    street: [0, 1, 2, 3].map(index => String(street[index] || '')),
                    city: String(value.city || ''),
                    region: String(value.region || ''),
                    region_id: Math.max(0, Number(value.region_id || value.regionId) || 0),
                    postcode: String(value.postcode || ''),
                    country_id: String(value.country_id || value.countryId || '').trim().toUpperCase(),
                    telephone: String(value.telephone || ''),
                    fax: String(value.fax || ''),
                    vat_id: String(value.vat_id || value.vatId || ''),
                    email: String(value.email || '')
                };
            },

            normalizeOrderAddressFormFields(fields = []) {
                const supported = new Set([
                    'prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company',
                    'street', 'city', 'region', 'postcode', 'country_id', 'telephone', 'fax', 'vat_id'
                ]);
                const normalized = Array.isArray(fields)
                    ? fields.reduce((result, field) => {
                        const code = String(field?.code || '').trim();
                        if (!supported.has(code) || result.some(item => item.code === code)) return result;
                        result.push({
                            code,
                            label: String(field?.label || code).slice(0, 120),
                            required: field?.required === true,
                            lineCount: code === 'street'
                                ? Math.max(1, Math.min(Number(field?.line_count) || 1, 4))
                                : 1
                        });
                        return result;
                    }, [])
                    : [];

                return normalized;
            },

            normalizeOrderAddressCountries(countries = []) {
                return Array.isArray(countries)
                    ? countries.reduce((result, country) => {
                        const value = String(country?.value || '').trim().toUpperCase();
                        if (!/^[A-Z]{2}$/.test(value) || result.some(item => item.value === value)) return result;
                        result.push({
                            value,
                            label: String(country?.label || value).slice(0, 120),
                            isRegionRequired: country?.is_region_required === true,
                            isZipRequired: country?.is_zip_required !== false
                        });
                        return result;
                    }, [])
                    : [];
            },

            normalizeOrderAddressRegions(regions = {}) {
                if (!regions || typeof regions !== 'object' || Array.isArray(regions)) return {};
                return Object.entries(regions).reduce((result, [countryId, source]) => {
                    const country = String(countryId || '').trim().toUpperCase();
                    if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(source)) return result;
                    const entries = source.reduce((items, region) => {
                        const id = Math.max(0, Number(region?.id) || 0);
                        const name = String(region?.name || '').trim().slice(0, 120);
                        if (id < 1 || !name || items.some(item => item.id === id)) return items;
                        items.push({
                            id,
                            code: String(region?.code || '').trim().slice(0, 32),
                            name
                        });
                        return items;
                    }, []);
                    if (entries.length) result[country] = entries;
                    return result;
                }, {});
            },

            orderAddressField(part, code) {
                return Array.isArray(part?.fields)
                    ? part.fields.find(field => field?.code === code) || null
                    : null;
            },

            orderAddressFieldVisible(part, code) {
                return Boolean(this.orderAddressField(part, code));
            },

            orderAddressFieldRequired(part, code) {
                if (this.orderAddressField(part, code)?.required === true) return true;
                const country = this.orderAddressCountry(part);
                if (code === 'postcode') return country?.isZipRequired === true;
                if (code === 'region') return country?.isRegionRequired === true;
                return false;
            },

            orderAddressFieldLabel(part, code, fallback) {
                const label = String(this.orderAddressField(part, code)?.label || fallback);
                return this.orderAddressFieldRequired(part, code) ? `${label} *` : label;
            },

            orderAddressStreetLineVisible(part, line) {
                const field = this.orderAddressField(part, 'street');
                return Boolean(field) && Number(field.lineCount || 1) >= line;
            },

            orderAddressCountry(part) {
                const countryId = String(part?.address?.country_id || '').trim().toUpperCase();
                return Array.isArray(part?.countries)
                    ? part.countries.find(country => country?.value === countryId) || null
                    : null;
            },

            orderAddressCountryRegions(part) {
                const countryId = String(part?.address?.country_id || '').trim().toUpperCase();
                const regions = part?.regions && typeof part.regions === 'object' ? part.regions : {};
                return Array.isArray(regions[countryId]) ? regions[countryId] : [];
            },

            changeOrderAddressCountry(part) {
                if (!part?.address) return;
                part.address.country_id = String(part.address.country_id || '').trim().toUpperCase();
                part.address.region_id = 0;
                part.address.region = '';
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            ensureOrderAddressCountrySelection(part) {
                if (!part || part.status === 'expired' || !part.addresses || typeof part.addresses !== 'object') return;
                const countries = Array.isArray(part.countries) ? part.countries : [];
                if (countries.length === 0) return;
                const allowedCountries = new Set(countries.map(country => country.value));

                ['billing', 'shipping'].forEach((type) => {
                    const address = part.addresses[type];
                    if (!address || typeof address !== 'object') return;

                    const currentCountry = String(address.country_id || '').trim().toUpperCase();
                    if (allowedCountries.has(currentCountry)) {
                        address.country_id = currentCountry;
                    } else if (countries.length === 1) {
                        // A store restricted to one allowed country should act
                        // like Magento Checkout: old address snapshots without
                        // country_id resolve to that sole valid option.
                        address.country_id = countries[0].value;
                    }
                });

                const activeAddress = part.addresses[part.addressType];
                if (activeAddress) {
                    part.address = this.normalizeOrderAddressFormValue(activeAddress);
                }
            },

            expireOrderAddressForm(part) {
                if (!part) return;
                if (part.expiryTimer) {
                    window.clearInterval(part.expiryTimer);
                    part.expiryTimer = null;
                }
                const emptyAddress = this.normalizeOrderAddressFormValue({});
                (Array.isArray(part.addressTypes) ? part.addressTypes : []).forEach((type) => {
                    if (type === 'billing' || type === 'shipping') {
                        part.addresses[type] = this.normalizeOrderAddressFormValue(emptyAddress);
                    }
                });
                part.address = this.normalizeOrderAddressFormValue(emptyAddress);
                part.actionToken = '';
                part.status = 'expired';
                part.remainingSeconds = 0;
                part.busy = false;
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            scheduleOrderAddressFormExpiry(part) {
                if (!part || part.status === 'success' || part.status === 'expired' || part.expiresAt <= 0) return;
                if (part.expiryTimer) window.clearInterval(part.expiryTimer);
                const update = () => {
                    part.remainingSeconds = Math.max(0, Math.ceil((part.expiresAt - Date.now()) / 1000));
                    if (part.status !== 'success' && part.remainingSeconds <= 0) {
                        this.expireOrderAddressForm(part);
                        this.scheduleGuestSessionSnapshot();
                    }
                };
                update();
                if (part.status !== 'expired') {
                    part.expiryTimer = window.setInterval(update, 1000);
                }
            },

            orderAddressCountdownLabel(part) {
                const seconds = Math.max(0, Math.floor(Number(part?.remainingSeconds) || 0));
                const minutes = Math.floor(seconds / 60);
                return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
            },

            expireOtherOrderAddressForms(activeFormId) {
                const activeId = String(activeFormId || '');
                this.messages.forEach((message) => {
                    (Array.isArray(message?.parts) ? message.parts : []).forEach((candidate) => {
                        if (candidate?.type === 'order_address_form'
                            && String(candidate.id || '') !== activeId
                            && candidate.status !== 'expired'
                        ) {
                            this.expireOrderAddressForm(candidate);
                        }
                    });
                });
            },

            enforceSingleActiveOrderAddressForm() {
                let activeId = '';
                let activePart = null;
                let foundLatestForm = false;
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0 && !foundLatestForm; messageIndex -= 1) {
                    const parts = Array.isArray(this.messages[messageIndex]?.parts)
                        ? this.messages[messageIndex].parts
                        : [];
                    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
                        const part = parts[partIndex];
                        if (part?.type !== 'order_address_form') continue;
                        foundLatestForm = true;
                        if (part.status !== 'expired' && part.expiresAt > Date.now()) {
                            activeId = String(part.id || '');
                            activePart = part;
                        }
                        break;
                    }
                }
                this.expireOtherOrderAddressForms(activeId);
                if (activePart) this.scheduleOrderAddressFormExpiry(activePart);
            },

            observeOrderAddressFormWidth(element, part) {
                if (!element || !part) return;
                const updateWidth = () => {
                    // Two columns only when the actual chat card has enough
                    // room. A desktop viewport can still contain a narrow
                    // floating chat window, so a viewport media query is not
                    // an accurate signal here.
                    part.isWide = element.clientWidth >= 576;
                };
                updateWidth();

                if (typeof ResizeObserver !== 'function' || element._afdOrderAddressResizeObserver) return;
                const observer = new ResizeObserver(updateWidth);
                observer.observe(element);
                element._afdOrderAddressResizeObserver = observer;
            },

            changeOrderAddressRegion(part) {
                if (!part?.address) return;
                const regionId = Math.max(0, Number(part.address.region_id) || 0);
                const region = this.orderAddressCountryRegions(part).find(item => item.id === regionId);
                part.address.region_id = regionId;
                part.address.region = region ? region.name : '';
            },

            createOrderAddressFormPart(data = {}) {
                const resourceType = data.resource_type === 'customer_account' ? 'customer_account' : 'order';
                const rawAddresses = data.addresses && typeof data.addresses === 'object'
                    ? data.addresses
                    : {};
                const countries = this.normalizeOrderAddressCountries(data.countries);
                const addresses = {
                    billing: rawAddresses.billing
                        ? this.normalizeOrderAddressFormValue(rawAddresses.billing)
                        : (resourceType === 'customer_account' ? this.normalizeOrderAddressFormValue({}) : null),
                    shipping: rawAddresses.shipping
                        ? this.normalizeOrderAddressFormValue(rawAddresses.shipping)
                        : (resourceType === 'customer_account' ? this.normalizeOrderAddressFormValue({}) : null)
                };
                const addressTypes = Array.isArray(data.address_types)
                    ? data.address_types.filter(type => ['billing', 'shipping'].includes(type) && addresses[type])
                    : ['billing', 'shipping'].filter(type => addresses[type]);
                const addressType = addressTypes.includes(data.address_type)
                    ? data.address_type
                    : (addressTypes.includes('shipping') ? 'shipping' : 'billing');
                const fields = this.normalizeOrderAddressFormFields(data.fields);

                const expiresAt = Math.max(0, Number(data.expires_at || data.expiresAt) || 0);
                const createdAt = Math.max(0, Number(data.created_at || data.createdAt) || 0);
                const isExpired = expiresAt > 0 && Date.now() >= expiresAt;
                if (isExpired) {
                    addressTypes.forEach((type) => {
                        addresses[type] = this.normalizeOrderAddressFormValue({});
                    });
                }
                const part = {
                    id: String(data.form_id || ('order-address-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
                    type: 'order_address_form',
                    actionToken: String(data.action_token || data.actionToken || '').slice(0, 2048),
                    resourceType,
                    accessScope: data.access_scope === 'customer' ? 'customer' : 'guest',
                    orderNumber: String(data.order_number || data.orderNumber || ''),
                    addressTypes,
                    addressType,
                    addresses,
                    fields,
                    countries,
                    regions: this.normalizeOrderAddressRegions(data.regions),
                    address: this.normalizeOrderAddressFormValue(addresses[addressType] || {}),
                    busy: false,
                    status: isExpired ? 'expired' : 'editing',
                    createdAt,
                    expiresAt,
                    remainingSeconds: isExpired ? 0 : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
                    expiryTimer: null,
                    isWide: false,
                    notice: '',
                    noticeVariant: 'neutral'
                };

                if (!isExpired) this.ensureOrderAddressCountrySelection(part);
                return part;
            },

            appendOrderAddressForm(data = {}) {
                const part = this.createOrderAddressFormPart(data);
                if ((part.resourceType === 'order' && !part.orderNumber) || part.addressTypes.length === 0) return null;
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = { role: 'assistant', feedbackEnabled: false, feedbackBusy: false, parts: [] };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                this.expireOtherOrderAddressForms(part.id);
                message.parts.push(part);
                this.scheduleOrderAddressFormExpiry(part);
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => {
                    // Alpine renders nested x-for options asynchronously. Run
                    // the selection reconciliation after that render so the
                    // select cannot be coerced back to its placeholder.
                    this.ensureOrderAddressCountrySelection(part);
                    this.scrollToBottom();
                });
                return part;
            },

            findOrderAddressForm(formId) {
                const id = String(formId || '');
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'order_address_form' && String(candidate.id) === id);
                    if (part) return part;
                }
                return null;
            },

            selectOrderAddressFormType(part, type) {
                if (!part || part.busy || part.status === 'expired' || !part.addressTypes.includes(type)) return;
                part.addressType = type;
                part.address = this.normalizeOrderAddressFormValue(part.addresses[type] || {});
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            resetOrderAddressFormRegion(part) {
                if (!part?.address) return;
                part.address.region_id = 0;
            },

            submitOrderAddressForm(part) {
                if (!part || part.busy || part.status === 'success' || part.status === 'expired') return;
                if (part.expiresAt > 0 && Date.now() >= part.expiresAt) {
                    this.expireOrderAddressForm(part);
                    this.scheduleGuestSessionSnapshot();
                    return;
                }
                const address = this.normalizeOrderAddressFormValue(part.address);
                const required = (Array.isArray(part.fields) ? part.fields : [])
                    .filter(field => field?.required === true)
                    .map(field => [field.code, field.label || field.code]);
                ['postcode', 'region'].forEach((code) => {
                    if (!this.orderAddressFieldRequired(part, code) || required.some(([field]) => field === code)) return;
                    required.push([code, this.orderAddressFieldLabel(part, code, code)]);
                });
                const missing = required.find(([field]) => (
                    field === 'street'
                        ? !address.street.some(line => line.trim())
                        : !String(address[field] || '').trim()
                ));
                if (missing) {
                    part.notice = `${missing[1]} is required.`;
                    part.noticeVariant = 'error';
                    return;
                }
                if (!/^[A-Z]{2}$/.test(address.country_id)) {
                    part.notice = 'Use a two-letter country code, for example DE.';
                    part.noticeVariant = 'error';
                    return;
                }
                if (!this.socket || !this.wsConnected) {
                    part.notice = 'The secure chat connection is unavailable. Please try again in a moment.';
                    part.noticeVariant = 'error';
                    return;
                }

                part.address = address;
                part.notice = '';
                part.busy = true;
                this.socket.send(JSON.stringify({
                    action: part.resourceType === 'customer_account'
                        ? 'customer_address_update'
                        : 'order_address_update',
                    form_id: String(part.id),
                    action_token: String(part.actionToken || ''),
                    order_number: String(part.orderNumber),
                    address_type: String(part.addressType),
                    address
                }));
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

            isProductPageLoading(part) {
                return Boolean(part?.id && this.productPageLoading[String(part.id)]);
            },

            productResultsSummary(part) {
                const payload = part?.payload || {};
                const pagination = payload.pagination || {};
                const coverage = payload.coverage || {};
                const total = Number(coverage.total ?? pagination.total);
                const visible = Number(coverage.shown
                    ?? (Array.isArray(payload.items) ? payload.items.length : pagination.returned || 0));

                if (!Number.isFinite(total) || total < 0 || !visible) return '';
                if (visible >= total) return `Showing all ${total} product${total === 1 ? '' : 's'}`;
                return `Showing ${visible} of ${total} matching products`;
            },

            productLoadMoreLabel(part) {
                const payload = part?.payload || {};
                const pagination = payload.pagination || {};
                const total = Number(pagination.total);
                const visible = Array.isArray(payload.items) ? payload.items.length : 0;
                const pageSize = Math.max(1, Number(pagination.page_size) || 5);
                const remaining = Number.isFinite(total) ? Math.max(0, total - visible) : pageSize;
                const nextCount = Math.min(pageSize, remaining || pageSize);

                return this.isProductPageLoading(part)
                    ? 'Loading products…'
                    : `Show ${nextCount} more`;
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
                        'More products are unavailable',
                        'The secure chat connection is reconnecting. Please try again in a moment.'
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
                await this.sendMessagePayload(
                    message.content || '',
                    retryAttachments,
                    message.content || 'Đã gửi hình ảnh',
                    false,
                    replaceFromMessageId
                );
            },

            async sendMessage() {
                if ((!this.userInput.trim() && this.imageAttachments.length === 0) || this.isLoading || this.isReadingAttachments) return;
                const text = this.userInput.trim();
                const attachments = this.imageAttachments.map(attachment => ({ ...attachment }));
                const displayText = text || (attachments.length > 1 ? `Đã gửi ${attachments.length} hình ảnh` : 'Đã gửi hình ảnh');
                this.cancelEditMessage();
                await this.sendMessagePayload(text, attachments, displayText, true);
            },

            async sendMessagePayload(text, attachments, displayText, restoreComposer, replaceFromMessageId = null) {
                const outgoingAttachments = Array.isArray(attachments) ? attachments.map(attachment => ({ ...attachment })) : [];
                if ((!text && outgoingAttachments.length === 0) || this.isLoading) return;
                if (this.humanSupportActive) this.stopSupportTyping();

                const cleanText = text.trim();
                const visibleText = displayText || (cleanText || (outgoingAttachments.length > 1 ? `Đã gửi ${outgoingAttachments.length} hình ảnh` : 'Đã gửi hình ảnh'));

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
                this.toolActivities = [];
                this.armResponseWatchdog();
                this.$nextTick(() => this.scrollToBottom(true));
                const outgoingUserParts = this.buildOutgoingUserParts(cleanText, outgoingAttachments);
                const history = this.buildModelHistory();
                const guestHistory = this.isLoggedIn ? [] : this.buildGuestHistorySnapshot();

                if (this.activeConversationId) {
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 180);
                }

                if (!this.socket || !this.wsConnected) {
                    await this.connectWebSocket();
                    await this.waitForSecureSocket();
                }

                if (this.socket && this.wsConnected) {
                    try {
                        this.socket.send(JSON.stringify({
                            action: 'chat',
                            request_id: requestId,
                            text: visibleText,
                            parts: outgoingUserParts,
                            // image is retained for older Node deployments; images is the multi-upload contract.
                            image: outgoingAttachments[0] ? {
                                name: outgoingAttachments[0].name,
                                type: outgoingAttachments[0].type,
                                size: outgoingAttachments[0].size,
                                data: outgoingAttachments[0].base64
                            } : null,
                            images: outgoingAttachments.map((attachment) => ({
                                name: attachment.name,
                                type: attachment.type,
                                size: attachment.size,
                                data: attachment.base64
                            })),
                            history: history,
                            guest_history: guestHistory,
                            conversation_id: this.activeConversationId,
                            // Editing/regenerating replaces the old branch in
                            // Magento as well as in the visible transcript.
                            replace_from_message_id: Number(replaceFromMessageId) || null
                        }));
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
                if (!data || !data.request_id) return false;
                if (this.cancelledRequestIds[data.request_id]) return true;
                return !!this.activeRequestId && data.request_id !== this.activeRequestId;
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
                return `You stopped after ${seconds}s`;
            },

            continueStoppedResponse() {
                if (this.isLoading || this.isReadingAttachments) return;
                this.sendMessagePayload(
                    'Continue your previous response from where you stopped. Do not repeat content that is already visible.',
                    [],
                    'Continue response',
                    true
                );
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
                        }
                    }
                    return;
                }

                if (['chunk', 'products_html', 'products_page', 'status', 'tool_activity', 'image_generation_started', 'image_generated', 'image_generation_failed', 'guest_order_access_required'].includes(data.type)) {
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

                } else if (data.type === 'chunk') {
                    this.statusMessage = '';
                    if (this.currentAiMessageIndex === -1) {
                        this.messages.push({
                            role: 'assistant',
                            request_id: data.request_id || this.activeRequestId || '',
                            feedbackEnabled: false,
                            feedbackBusy: false,
                            parts: [this.createStreamingTextPart(data.content || '')]
                        });
                        this.currentAiMessageIndex = this.messages.length - 1;
                    } else {
                        const msg = this.messages[this.currentAiMessageIndex];
                        if (msg) {
                            let lastPart = msg.parts[msg.parts.length - 1];
                            if (!lastPart || lastPart.type !== 'text') {
                                msg.parts.push(this.createStreamingTextPart());
                                lastPart = msg.parts[msg.parts.length - 1];
                            }
                            this.appendStreamingText(lastPart, data.content || '');
                        }
                    }
                    // Streaming snapshots are durability checkpoints, not a
                    // per-frame render concern. The final `done` event still
                    // persists immediately.
                    this.scheduleGuestSessionSnapshot(900);
                    this.scheduleStreamingScroll();

                } else if (data.type === 'tool_activity') {
                    const activityId = String(data.activity_id || 'tool-' + Date.now() + '-' + Math.random());
                    const nextActivity = {
                        id: activityId,
                        tool: String(data.tool || ''),
                        state: ['running', 'completed', 'failed'].includes(data.state) ? data.state : 'running',
                        result_count: Number.isFinite(Number(data.result_count)) ? Number(data.result_count) : null
                    };
                    const activityIndex = this.toolActivities.findIndex(activity => activity.id === activityId);

                    if (activityIndex === -1) {
                        this.toolActivities.push(nextActivity);
                    } else {
                        this.toolActivities.splice(activityIndex, 1, {
                            ...this.toolActivities[activityIndex],
                            ...nextActivity
                        });
                    }

                    // A model may publish customer-facing prose, then decide a
                    // second retrieval is needed. Start the following text in a
                    // new message so the live timeline stays between the two
                    // visible response phases instead of overwriting either.
                    if (nextActivity.state === 'running') {
                        this.currentAiMessageIndex = -1;
                    }
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
                    const currentMessage = this.currentAiMessageIndex >= 0
                        ? this.messages[this.currentAiMessageIndex]
                        : null;
                    const hasCustomerFacingText = Array.isArray(currentMessage?.parts)
                        && currentMessage.parts.some((part) => (
                            part?.type === 'text'
                            && String(part.raw || part.html || '').trim().length > 0
                        ));
                    // Current gateways emit the accepted grid after final
                    // prose. Attach it immediately so it does not look missing
                    // while persistence and title updates finish. An older
                    // gateway that sends it before prose remains buffered.
                    if (hasCustomerFacingText) {
                        this.flushPendingProductParts();
                        this.$nextTick(() => this.scrollToBottom());
                    }

                } else if (data.type === 'products_page') {
                    this.appendProductPage(data);

                } else if (data.type === 'product_page_error') {
                    this.completeProductPageRequest(data.product_part_id);
                    this.setTransportNotice(
                        'catalog-page-failed',
                        'More products could not be loaded',
                        data.content || 'Please try again in a moment.'
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
                    const formId = String(data.form_id || data.formId || '');
                    const alreadyQueued = this.pendingGuestOrderAccessParts.some(
                        part => formId && String(part?.form_id || part?.formId || '') === formId
                    );
                    if (!alreadyQueued) {
                        this.pendingGuestOrderAccessParts.push(data);
                    }

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

                } else if (data.type === 'status') {
                    this.statusMessage = this.normalizeStatusMessage(data.content);
                    this.isLoading = true;

                } else if (data.type === 'done') {
                    const completedRequestId = String(data.request_id || this.activeRequestId || '');
                    this.finalizeStreamingMarkdown();
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
                    });
                    if (data.request_id) {
                        delete this.cancelledRequestIds[data.request_id];
                    }
                    this.scheduleGuestSessionSnapshot();
                    this.scrollToBottom();
                    this.scheduleCrossTabConversationSync(this.activeConversationId, 360);
                    if (Number(this.pendingSupportConversationId) === Number(this.activeConversationId)) {
                        const conversationId = Number(this.pendingSupportConversationId);
                        this.pendingSupportConversationId = 0;
                        window.setTimeout(() => this.switchConversation(conversationId, true), 0);
                    }

                } else if (data.type === 'cancelled') {
                    this.recordInterruptedResponse(data.stopped_after_seconds);
                    this.isLoading = false;
                    this.statusMessage = '';
                    this.currentAiMessageIndex = -1;
                    this.pendingProductParts = [];
                    this.pendingOrderAddressFormParts = [];
                    this.pendingGuestOrderAccessParts = [];
                    this.responseStartedAt = 0;
                    this.clearResponseWatchdog();
                    if (!data.request_id || data.request_id === this.activeRequestId) {
                        this.activeRequestId = null;
                    }
                }
            },

            flushPendingProductParts() {
                if (!Array.isArray(this.pendingProductParts) || this.pendingProductParts.length === 0) {
                    return;
                }

                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = { role: 'assistant', feedbackEnabled: false, feedbackBusy: false, parts: [] };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                message.parts.push(...this.pendingProductParts);
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

                this.disposeStreamingMessage(message);
                this.messages.splice(index, 1);
                this.currentAiMessageIndex = -1;
                this.scheduleGuestSessionSnapshot();
            },

            // ==================== UTILITIES ====================
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
