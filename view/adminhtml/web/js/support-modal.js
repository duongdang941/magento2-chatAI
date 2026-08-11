define(['jquery', 'Magento_Ui/js/modal/modal', 'Afd_AI/js/support-realtime'], function ($, modal, createSupportRealtime) {
    'use strict';

    return function (config, modalRoot) {
        const chatRoot = modalRoot.querySelector('[data-role="chat-root"]');
        const messages = modalRoot.querySelector('[data-role="messages"]');
        const composer = modalRoot.querySelector('[data-role="composer"]');
        const input = composer.querySelector('textarea');
        const sendButton = composer.querySelector('.afd-ai-chat__send-btn');
        const closedNotice = modalRoot.querySelector('[data-role="closed"]');
        const notice = modalRoot.querySelector('[data-role="notice"]');
        const ticketList = modalRoot.querySelector('[data-role="ticket-list"]');
        const ticketTotal = modalRoot.querySelector('[data-role="ticket-total"]');
        const ticketSearch = modalRoot.querySelector('[data-role="ticket-search"]');
        const ticketSearchWrap = modalRoot.querySelector('[data-role="ticket-search-wrap"]');
        const settings = modalRoot.querySelector('[data-role="settings"]');
        const accentInput = modalRoot.querySelector('[data-role="accent-input"]');
        const accentValue = modalRoot.querySelector('[data-role="accent-value"]');
        const accentColorValue = modalRoot.querySelector('[data-role="accent-color-value"]');
        const glassOpacity = modalRoot.querySelector('[data-role="glass-opacity"]');
        const glassOpacityValue = modalRoot.querySelector('[data-role="glass-opacity-value"]');
        const spacingHelp = modalRoot.querySelector('[data-role="spacing-help"]');
        const petMotion = modalRoot.querySelector('[data-role="pet-motion"]');
        const launcherReset = modalRoot.querySelector('[data-role="launcher-reset"]');
        const formKey = String(composer.querySelector('input[name="form_key"]')?.value || '');
        const preferenceKey = 'afd_ai_chat_ui_settings';
        let currentCaseId = 0;
        let currentConversationId = 0;
        let lastMessageId = 0;
        let tickets = [];
        let requestVersion = 0;
        let polling = false;
        let opened = false;
        let typingIdleTimer = null;
        let remoteTypingTimer = null;
        let realtime = null;

        modal({
            type: 'popup',
            responsive: true,
            innerScroll: false,
            modalClass: 'afd-ai-support-modal-shell',
            title: '',
            buttons: [],
            clickableOverlay: true,
            closed: function () {
                opened = false;
                realtime?.setTyping(false, true);
                chatRoot.classList.remove('is-sidebar-open');
                closeDeleteConfirmation();
                closeSettings();
            }
        }, $(modalRoot));

        const resolveTheme = (theme) => theme === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme;

        const loadPreferences = () => {
            let preferences = {
                theme: 'light',
                accent: '#c32654',
                glassOpacity: 100,
                fontSize: 'medium',
                density: 'comfortable',
                petMotion: true
            };
            try {
                preferences = { ...preferences, ...JSON.parse(localStorage.getItem(preferenceKey) || '{}') };
            } catch (error) {}
            if (!['light', 'dark', 'system'].includes(preferences.theme)) preferences.theme = 'light';
            if (!/^#[0-9a-f]{6}$/i.test(preferences.accent)) preferences.accent = '#c32654';
            const savedOpacity = Number(preferences.glassOpacity);
            preferences.glassOpacity = Number.isFinite(savedOpacity)
                ? Math.min(100, Math.max(0, Math.round(savedOpacity)))
                : 100;
            if (!['small', 'medium', 'large'].includes(preferences.fontSize)) preferences.fontSize = 'medium';
            if (!['comfortable', 'compact'].includes(preferences.density)) preferences.density = 'comfortable';
            preferences.petMotion = preferences.petMotion !== false;
            return preferences;
        };

        let preferences = loadPreferences();
        const applyPreferences = () => {
            chatRoot.dataset.uiTheme = resolveTheme(preferences.theme);
            chatRoot.dataset.uiDensity = preferences.density;
            chatRoot.dataset.uiFontSize = preferences.fontSize;
            chatRoot.dataset.uiGlass = preferences.glassOpacity < 100 ? 'true' : 'false';
            chatRoot.style.setProperty('--afd-chat-accent-live', preferences.accent);
            chatRoot.style.setProperty('--afd-chat-glass-alpha', (preferences.glassOpacity / 100).toFixed(2));
            chatRoot.style.setProperty('--afd-chat-glass-content-alpha', Math.min(0.94, Math.max(0.46, (preferences.glassOpacity / 100) + 0.18)).toFixed(2));
            modalRoot.querySelectorAll('[data-theme]').forEach((button) => {
                button.classList.toggle('afd-ai-chat__segment--active', button.dataset.theme === preferences.theme);
            });
            modalRoot.querySelectorAll('[data-accent]').forEach((button) => {
                button.classList.toggle('afd-ai-chat__swatch--active', button.dataset.accent.toLowerCase() === preferences.accent.toLowerCase());
            });
            modalRoot.querySelectorAll('[data-font-size]').forEach((button) => {
                button.classList.toggle('afd-ai-chat__segment--active', button.dataset.fontSize === preferences.fontSize);
            });
            modalRoot.querySelectorAll('[data-density]').forEach((button) => {
                button.classList.toggle('afd-ai-chat__segment--active', button.dataset.density === preferences.density);
            });
            accentInput.value = preferences.accent;
            accentValue.textContent = preferences.accent;
            accentColorValue.textContent = preferences.accent;
            glassOpacity.value = String(preferences.glassOpacity);
            glassOpacityValue.textContent = preferences.glassOpacity + '%';
            glassOpacity.setAttribute('aria-valuetext', preferences.glassOpacity + '%');
            spacingHelp.textContent = preferences.density === 'compact'
                ? 'Compact layout: 6px between messages.'
                : 'Roomy layout: 28px between messages.';
            petMotion.checked = preferences.petMotion;
            try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch (error) {}
        };

        const setPreference = (key, value) => {
            preferences = { ...preferences, [key]: value };
            applyPreferences();
        };

        const syncSendButton = () => {
            sendButton.disabled = composer.hidden
                || composer.classList.contains('is-sending')
                || !input.value.trim();
        };

        const setNotice = (text = '', variant = 'error') => {
            notice.textContent = String(text || '');
            notice.dataset.variant = variant;
            notice.hidden = !text;
        };

        const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 110;
        const scrollBottom = (force = false) => {
            if (force || nearBottom()) messages.scrollTop = messages.scrollHeight;
        };

        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'afd-ai-chat__msg-ai afd-ai-support-typing';
        typingIndicator.hidden = true;
        typingIndicator.innerHTML = '<div class="afd-ai-chat__msg-content"><div class="afd-ai-chat__msg-assistant-stack"><div class="afd-ai-chat__typing-bubble" aria-label="Customer is typing"><span></span><span></span><span></span></div></div></div>';

        const setRemoteTyping = (typing) => {
            if (remoteTypingTimer) window.clearTimeout(remoteTypingTimer);
            if (typing) {
                if (!typingIndicator.isConnected) messages.appendChild(typingIndicator);
                typingIndicator.hidden = false;
                scrollBottom();
                remoteTypingTimer = window.setTimeout(() => setRemoteTyping(false), 2600);
            } else {
                typingIndicator.hidden = true;
            }
        };

        const syncLocalTyping = (forceHeartbeat = false) => {
            if (typingIdleTimer) window.clearTimeout(typingIdleTimer);
            const typing = opened && Boolean(input.value.trim()) && !composer.hidden;
            realtime?.setTyping(typing, forceHeartbeat && typing);
            if (typing) {
                typingIdleTimer = window.setTimeout(() => syncLocalTyping(true), 900);
            }
        };

        const createMaterialIcon = (name) => {
            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = name;
            return icon;
        };

        const createMessageAction = (icon, label, handler, extraClass = '') => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'afd-ai-chat__msg-action afd-ai-chat__msg-action--icon' + (extraClass ? ' ' + extraClass : '');
            button.title = label;
            button.setAttribute('aria-label', label);
            button.appendChild(createMaterialIcon(icon));
            button.addEventListener('click', handler);
            return button;
        };

        const copyTextToClipboard = async (value) => {
            const text = String(value || '');
            if (!text) return false;
            const fallback = document.createElement('textarea');
            fallback.value = text;
            fallback.setAttribute('readonly', 'readonly');
            fallback.style.position = 'fixed';
            fallback.style.left = '-9999px';
            fallback.style.opacity = '0';
            document.body.appendChild(fallback);
            fallback.focus();
            fallback.select();
            let copied = false;
            try {
                copied = typeof document.execCommand === 'function' && document.execCommand('copy');
            } finally {
                fallback.remove();
            }
            if (copied) return true;
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                try {
                    await navigator.clipboard.writeText(text);
                    return true;
                } catch (error) {}
            }
            if (!copied) throw new Error('Clipboard access was denied.');
            return true;
        };

        const copyMessage = async (row, button) => {
            const text = row.querySelector('[data-role="message-text"]')?.textContent || '';
            try {
                await copyTextToClipboard(text);
                const icon = button.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = 'check';
                button.classList.add('afd-ai-chat__msg-action--active');
                button.title = 'Copied';
                button.setAttribute('aria-label', 'Copied');
                window.setTimeout(() => {
                    if (!button.isConnected) return;
                    if (icon) icon.textContent = 'content_copy';
                    button.classList.remove('afd-ai-chat__msg-action--active');
                    button.title = 'Copy message';
                    button.setAttribute('aria-label', 'Copy message');
                }, 1400);
                setNotice('');
            } catch (error) {
                setNotice('This browser did not allow copying the message.');
            }
        };

        const closeDeleteConfirmation = () => {
            chatRoot.querySelector('[data-role="message-delete-confirmation"]')?.remove();
        };

        const requestMessageDelete = (row, returnFocus) => {
            closeDeleteConfirmation();
            const overlay = document.createElement('div');
            overlay.className = 'afd-ai-chat__confirm-overlay';
            overlay.dataset.role = 'message-delete-confirmation';
            overlay.innerHTML = [
                '<section class="afd-ai-chat__confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="afd-ai-admin-confirm-title" aria-describedby="afd-ai-admin-confirm-description">',
                '<div class="afd-ai-chat__confirm-heading">',
                '<span class="afd-ai-chat__confirm-icon" aria-hidden="true"><span class="material-symbols-outlined">delete</span></span>',
                '<div class="afd-ai-chat__confirm-copy">',
                '<p class="afd-ai-chat__confirm-kicker">Support message</p>',
                '<h3 id="afd-ai-admin-confirm-title" class="afd-ai-chat__confirm-title">Delete this message?</h3>',
                '<p id="afd-ai-admin-confirm-description" class="afd-ai-chat__confirm-description">The message will be hidden for the customer and support staff, while an audit copy remains securely stored.</p>',
                '</div></div>',
                '<p class="afd-ai-chat__confirm-preview" data-role="confirmation-preview"></p>',
                '<div class="afd-ai-chat__confirm-actions">',
                '<button type="button" class="afd-ai-chat__confirm-btn afd-ai-chat__confirm-btn--cancel" data-action="cancel">Cancel</button>',
                '<button type="button" class="afd-ai-chat__confirm-btn afd-ai-chat__confirm-btn--danger" data-action="confirm"><span class="material-symbols-outlined" aria-hidden="true">delete</span><span>Delete message</span></button>',
                '</div></section>'
            ].join('');
            overlay.querySelector('[data-role="confirmation-preview"]').textContent =
                (row.querySelector('[data-role="message-text"]')?.textContent || '').trim().slice(0, 240);
            const cancel = overlay.querySelector('[data-action="cancel"]');
            const confirm = overlay.querySelector('[data-action="confirm"]');
            const close = () => {
                overlay.remove();
                if (returnFocus?.isConnected) returnFocus.focus();
            };
            cancel.addEventListener('click', close);
            confirm.addEventListener('click', () => {
                overlay.remove();
                submitMessageMutation(row, 'delete');
            });
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) close();
            });
            overlay.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    close();
                }
            });
            chatRoot.querySelector('.afd-ai-chat__window').appendChild(overlay);
            window.setTimeout(() => cancel.focus(), 0);
        };

        const applyMessageMutation = (mutation) => {
            if (Number(mutation.conversation_id) !== currentConversationId) return;
            const row = messages.querySelector('[data-message-id="' + Number(mutation.message_id) + '"]');
            if (!row) {
                loadMessages({ replace: true, forceScroll: false });
                return;
            }
            const bubble = row.querySelector('[data-role="message-bubble"]');
            const text = row.querySelector('[data-role="message-text"]');
            const meta = row.querySelector('[data-role="message-meta"]');
            row.querySelector('.afd-ai-chat__msg-edit-shell')?.remove();
            const stack = row.querySelector('.afd-ai-chat__msg-user-stack, .afd-ai-chat__msg-assistant-stack');
            if (stack) stack.hidden = false;
            if (text) text.hidden = false;
            row.classList.remove('is-mutating');
            if (mutation.operation === 'delete') {
                bubble?.classList.add('afd-ai-chat__msg-deleted');
                if (text) text.textContent = 'This message was deleted.';
                if (meta) meta.remove();
                return;
            }
            bubble?.classList.remove('afd-ai-chat__msg-deleted');
            if (text) text.textContent = String(mutation.content || '');
            if (meta && !meta.querySelector('.afd-ai-chat__msg-edited')) {
                const edited = document.createElement('span');
                edited.className = 'afd-ai-chat__msg-edited';
                edited.textContent = 'Edited';
                meta.prepend(edited);
            }
        };

        const submitMessageMutation = async (row, operation, content = '') => {
            if (!currentCaseId || !row || row.classList.contains('is-mutating')) return;
            row.classList.add('is-mutating');
            const body = new FormData();
            body.set('form_key', formKey);
            body.set('entity_id', String(currentCaseId));
            body.set('message_id', String(row.dataset.messageId || ''));
            if (operation === 'edit') body.set('content', String(content || '').trim());
            try {
                const response = await fetch(operation === 'delete' ? config.deleteMessageUrl : config.editMessageUrl, {
                    method: 'POST', body, credentials: 'same-origin',
                    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                });
                const payload = await response.json();
                if (!response.ok || payload.status !== 'success') throw new Error(payload.message || 'Message could not be changed.');
                applyMessageMutation(payload);
                setNotice('');
            } catch (error) {
                row.classList.remove('is-mutating');
                setNotice(error.message || 'Message could not be changed.');
            }
        };

        const beginMessageEdit = (row) => {
            const bubble = row.querySelector('[data-role="message-bubble"]');
            const text = row.querySelector('[data-role="message-text"]');
            const content = row.querySelector('.afd-ai-chat__msg-user-content');
            const stack = row.querySelector('.afd-ai-chat__msg-user-stack');
            if (!bubble || !text || !content || !stack || content.querySelector('.afd-ai-chat__msg-edit-shell')) return;
            const original = text.textContent || '';
            stack.hidden = true;
            const form = document.createElement('form');
            form.className = 'afd-ai-chat__msg-edit-shell';
            form.innerHTML = '<textarea class="afd-ai-chat__msg-edit-input" maxlength="4000" rows="1" placeholder="Edit message"></textarea><div class="afd-ai-chat__msg-edit-actions"><button type="button" class="afd-ai-chat__msg-edit-btn afd-ai-chat__msg-edit-btn--ghost" data-action="cancel">Cancel</button><button type="submit" class="afd-ai-chat__msg-edit-btn afd-ai-chat__msg-edit-btn--primary" data-action="save">Save</button></div>';
            const textarea = form.querySelector('textarea');
            textarea.value = original;
            const resize = () => {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 256) + 'px';
            };
            form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
                form.remove();
                stack.hidden = false;
            });
            textarea.addEventListener('input', resize);
            textarea.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                form.remove();
                stack.hidden = false;
            });
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const next = textarea.value.trim();
                if (!next || next === original) {
                    form.remove();
                    stack.hidden = false;
                    return;
                }
                submitMessageMutation(row, 'edit', next);
            });
            content.appendChild(form);
            resize();
            window.setTimeout(() => {
                form.scrollIntoView({ block: 'nearest' });
                textarea.focus();
                textarea.select();
            }, 0);
        };

        const appendMessage = (message, forceScroll = false) => {
            if (!message.entity_id || messages.querySelector('[data-message-id="' + message.entity_id + '"]')) return;
            const shouldScroll = forceScroll || nearBottom();
            const row = document.createElement('div');
            const content = document.createElement('div');
            const stack = document.createElement('div');
            const bubble = document.createElement('div');
            const isAgent = message.source === 'support_agent';
            const isCustomer = message.role === 'user';
            const isDeleted = message.is_deleted === true;
            row.dataset.messageId = String(message.entity_id);

            // This screen is viewed by an admin. Support-agent messages are
            // therefore local messages on the right; customer messages are
            // incoming messages on the left.
            if (isAgent) {
                row.className = 'afd-ai-chat__msg-user';
                content.className = 'afd-ai-chat__msg-user-content';
                stack.className = 'afd-ai-chat__msg-user-stack';
                bubble.className = 'afd-ai-chat__msg-bubble-user';
                const text = document.createElement('div');
                text.className = 'afd-ai-chat__msg-user-text';
                text.dataset.role = 'message-text';
                text.textContent = isDeleted ? 'This message was deleted.' : String(message.text || '');
                bubble.appendChild(text);
            } else {
                row.className = 'afd-ai-chat__msg-ai';
                content.className = 'afd-ai-chat__msg-content';
                stack.className = 'afd-ai-chat__msg-assistant-stack';
                bubble.className = isCustomer
                    ? 'afd-ai-chat__msg-bubble-customer'
                    : 'afd-ai-chat__msg-bubble-ai';
                const text = document.createElement('div');
                text.className = 'afd-ai-chat__msg-part';
                text.dataset.role = 'message-text';
                text.textContent = isDeleted ? 'This message was deleted.' : String(message.text || '');
                bubble.appendChild(text);
            }
            bubble.dataset.role = 'message-bubble';
            if (isDeleted) bubble.classList.add('afd-ai-chat__msg-deleted');
            stack.appendChild(bubble);
            if (!isDeleted) {
                const meta = document.createElement('div');
                const actions = document.createElement('div');
                meta.className = 'afd-ai-chat__msg-meta ' + (isAgent
                    ? 'afd-ai-chat__msg-meta--user'
                    : 'afd-ai-chat__msg-meta--assistant');
                meta.dataset.role = 'message-meta';
                if (message.is_edited === true) {
                    const edited = document.createElement('span');
                    edited.className = 'afd-ai-chat__msg-edited';
                    edited.textContent = 'Edited';
                    meta.appendChild(edited);
                }
                actions.className = 'afd-ai-chat__msg-actions ' + (isAgent
                    ? 'afd-ai-chat__msg-actions--user'
                    : 'afd-ai-chat__msg-actions--assistant');
                let copy;
                copy = createMessageAction('content_copy', 'Copy message', () => copyMessage(row, copy));
                actions.appendChild(copy);
                if (isAgent && message.can_mutate === true) {
                    actions.appendChild(createMessageAction('edit', 'Edit message', () => beginMessageEdit(row)));
                    let remove;
                    remove = createMessageAction(
                        'delete',
                        'Delete message',
                        () => requestMessageDelete(row, remove),
                        'afd-ai-chat__msg-action--danger'
                    );
                    actions.appendChild(remove);
                }
                meta.appendChild(actions);
                stack.appendChild(meta);
            }
            content.appendChild(stack);
            row.appendChild(content);
            messages.insertBefore(row, typingIndicator.isConnected ? typingIndicator : null);
            lastMessageId = Math.max(lastMessageId, Number(message.entity_id) || 0);
            if (shouldScroll) scrollBottom(true);
        };

        const updateCase = (supportCase) => {
            if (!supportCase) return;
            currentCaseId = Number(supportCase.entity_id) || currentCaseId;
            const nextConversationId = Number(supportCase.conversation_id) || 0;
            if (nextConversationId !== currentConversationId) {
                currentConversationId = nextConversationId;
                realtime?.subscribe(currentConversationId);
            }
            modalRoot.querySelector('[data-role="contact-email"]').textContent = String(supportCase.contact_email || '');
            modalRoot.querySelector('[data-role="case-subject"]').textContent = String(supportCase.subject || '');
            modalRoot.querySelector('[data-role="case-public-id"]').textContent = String(supportCase.public_id || '');
            modalRoot.querySelector('[data-role="case-status"]').textContent = String(supportCase.status || '');
            composer.querySelector('input[name="entity_id"]').value = String(currentCaseId);
            composer.hidden = supportCase.can_reply !== true;
            closedNotice.hidden = supportCase.can_reply === true;
            syncSendButton();
            if (composer.hidden) realtime?.setTyping(false, true);
        };

        const renderTickets = () => {
            const query = ticketSearch.value.trim().toLocaleLowerCase();
            const visibleTickets = tickets.filter((ticket) => !query || [ticket.subject, ticket.public_id, ticket.status]
                .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
            ticketList.replaceChildren();
            ticketTotal.textContent = String(tickets.length);
            visibleTickets.forEach((ticket) => {
                const wrap = document.createElement('div');
                const button = document.createElement('button');
                const icon = document.createElement('span');
                const copy = document.createElement('span');
                const title = document.createElement('span');
                const track = document.createElement('span');
                const meta = document.createElement('span');
                const publicId = document.createElement('span');
                const status = document.createElement('span');
                const active = Number(ticket.entity_id) === currentCaseId;
                wrap.className = 'afd-ai-chat__sidebar-item-wrap' + (active ? ' afd-ai-chat__sidebar-item-wrap--active' : '') + (Number(ticket.admin_unread_count) > 0 ? ' is-unread' : '');
                button.type = 'button';
                button.className = 'afd-ai-chat__sidebar-item' + (active ? ' afd-ai-chat__sidebar-item--active' : '');
                button.dataset.caseId = String(ticket.entity_id);
                button.dataset.conversationId = String(ticket.conversation_id || 0);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
                icon.className = 'afd-ai-support-ticket-icon';
                icon.textContent = ['closed', 'resolved'].includes(ticket.status) ? '✓' : '#';
                copy.className = 'afd-ai-chat__sidebar-item-copy';
                title.className = 'afd-ai-chat__sidebar-item-title';
                track.className = 'afd-ai-chat__sidebar-item-title-track';
                track.textContent = String(ticket.subject || ticket.public_id || 'Ticket');
                meta.className = 'afd-ai-support-ticket-meta';
                publicId.textContent = String(ticket.public_id || '');
                status.textContent = String(ticket.status || 'open');
                title.appendChild(track);
                meta.append(publicId, status);
                copy.append(title, meta);
                button.append(icon, copy);
                if (Number(ticket.admin_unread_count) > 0) {
                    const unread = document.createElement('span');
                    unread.className = 'afd-ai-support-unread';
                    unread.textContent = String(ticket.admin_unread_count);
                    button.appendChild(unread);
                }
                button.addEventListener('click', () => selectTicket(Number(ticket.entity_id)));
                wrap.appendChild(button);
                ticketList.appendChild(wrap);
            });
        };

        const markRead = async (caseId) => {
            const body = new FormData();
            body.set('entity_id', String(caseId));
            body.set('form_key', formKey);
            try {
                await fetch(config.markReadUrl, { method: 'POST', body, credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
                tickets = tickets.map((ticket) => Number(ticket.entity_id) === Number(caseId) ? { ...ticket, admin_unread_count: 0 } : ticket);
                renderTickets();
            } catch (error) {}
        };

        const loadMessages = async ({ replace = false, forceScroll = false } = {}) => {
            if (!currentCaseId || (polling && !replace)) return;
            const version = replace ? ++requestVersion : requestVersion;
            polling = true;
            if (replace) messages.classList.add('is-loading');
            try {
                const url = new URL(config.messagesUrl, window.location.origin);
                url.searchParams.set('entity_id', String(currentCaseId));
                url.searchParams.set('after_id', replace ? '0' : String(lastMessageId));
                const response = await fetch(url.toString(), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
                const payload = await response.json();
                if (!response.ok || payload.status !== 'success' || version !== requestVersion) throw new Error(payload.message || 'Conversation could not be loaded.');
                if (replace) {
                    messages.replaceChildren();
                    lastMessageId = 0;
                    tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
                    updateCase(payload.case);
                    renderTickets();
                }
                (payload.messages || []).forEach((message) => appendMessage(message, forceScroll || replace));
                setNotice('');
            } catch (error) {
                setNotice(error.message || 'Conversation could not be loaded.');
            } finally {
                polling = false;
                messages.classList.remove('is-loading');
            }
        };

        async function selectTicket(caseId) {
            if (!caseId) return;
            closeDeleteConfirmation();
            realtime?.setTyping(false, true);
            currentCaseId = caseId;
            currentConversationId = Number(tickets.find((ticket) => Number(ticket.entity_id) === caseId)?.conversation_id) || 0;
            lastMessageId = 0;
            setRemoteTyping(false);
            realtime?.subscribe(currentConversationId);
            chatRoot.classList.remove('is-sidebar-open');
            await loadMessages({ replace: true, forceScroll: true });
            await markRead(caseId);
        }

        const openSettings = () => {
            closeDeleteConfirmation();
            settings.hidden = false;
            chatRoot.classList.remove('is-sidebar-open');
        };
        function closeSettings() {
            settings.hidden = true;
        }

        const openCase = async (caseId) => {
            if (!caseId) return;
            opened = true;
            currentCaseId = caseId;
            currentConversationId = 0;
            lastMessageId = 0;
            setRemoteTyping(false);
            realtime?.subscribe(0);
            messages.replaceChildren();
            closeDeleteConfirmation();
            closeSettings();
            $(modalRoot).modal('openModal');
            await loadMessages({ replace: true, forceScroll: true });
            await markRead(caseId);
            syncLocalTyping();
        };

        document.addEventListener('click', (event) => {
            const link = event.target.closest('a[href*="afd_ai/supportcase/view"]');
            if (!link) return;
            const url = new URL(link.href, window.location.origin);
            const match = url.pathname.match(/\/entity_id\/(\d+)/) || url.search.match(/[?&]entity_id=(\d+)/);
            const caseId = Number(match?.[1]) || 0;
            if (!caseId) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            openCase(caseId);
        }, true);

        const submitReply = async () => {
            const reply = input.value.trim();
            if (!reply || composer.classList.contains('is-sending')) {
                syncSendButton();
                return;
            }
            const body = new FormData(composer);
            body.set('reply', reply);
            const pendingId = 'pending-' + Date.now();
            input.value = '';
            input.style.height = '';
            composer.classList.remove('afd-ai-chat__composer-shell--expanded');
            composer.classList.add('is-sending');
            realtime?.setTyping(false, true);
            appendMessage({
                entity_id: pendingId,
                role: 'assistant',
                source: 'support_agent',
                text: reply
            }, true);
            syncSendButton();
            try {
                const response = await fetch(config.replyUrl, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
                const payload = await response.json();
                if (!response.ok || payload.status !== 'success') throw new Error(payload.message || 'Message could not be sent.');
                messages.querySelector('[data-message-id="' + pendingId + '"]')?.remove();
                await loadMessages({ forceScroll: true });
            } catch (error) {
                messages.querySelector('[data-message-id="' + pendingId + '"]')?.remove();
                if (!input.value.trim()) input.value = reply;
                setNotice(error.message || 'Message could not be sent.');
            } finally {
                composer.classList.remove('is-sending');
                syncSendButton();
                input.focus();
            }
        };
        composer.addEventListener('submit', (event) => {
            event.preventDefault();
            submitReply();
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            submitReply();
        }, true);
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 144) + 'px';
            composer.classList.toggle('afd-ai-chat__composer-shell--expanded', Boolean(input.value.trim()) && input.scrollHeight > 44);
            syncSendButton();
            syncLocalTyping();
        });
        realtime = createSupportRealtime({
            ticketUrl: config.socketTicketUrl,
            onTyping: setRemoteTyping,
            onMessage: () => {
                setRemoteTyping(false);
                if (opened && !document.hidden) loadMessages({ forceScroll: true });
            },
            onMutation: applyMessageMutation
        });

        modalRoot.querySelector('[data-role="modal-close"]').addEventListener('click', () => $(modalRoot).modal('closeModal'));
        modalRoot.querySelector('[data-role="sidebar-toggle"]').addEventListener('click', () => chatRoot.classList.toggle('is-sidebar-open'));
        modalRoot.querySelector('[data-role="sidebar-close"]').addEventListener('click', () => chatRoot.classList.remove('is-sidebar-open'));
        modalRoot.querySelector('[data-role="ticket-search-toggle"]').addEventListener('click', () => {
            chatRoot.classList.add('is-sidebar-open');
            ticketSearchWrap.hidden = false;
            window.setTimeout(() => ticketSearch.focus(), 0);
        });
        ticketSearch.addEventListener('input', renderTickets);
        modalRoot.querySelector('[data-role="settings-open"]').addEventListener('click', openSettings);
        modalRoot.querySelector('[data-role="settings-close"]').addEventListener('click', closeSettings);
        modalRoot.querySelectorAll('[data-theme]').forEach((button) => button.addEventListener('click', () => {
            setPreference('theme', button.dataset.theme);
        }));
        modalRoot.querySelectorAll('[data-accent]').forEach((button) => button.addEventListener('click', () => {
            setPreference('accent', button.dataset.accent);
        }));
        accentInput.addEventListener('input', () => setPreference('accent', accentInput.value.toLowerCase()));
        glassOpacity.addEventListener('input', () => setPreference(
            'glassOpacity',
            Math.min(100, Math.max(0, Math.round(Number(glassOpacity.value) || 0)))
        ));
        modalRoot.querySelectorAll('[data-font-size]').forEach((button) => button.addEventListener('click', () => {
            setPreference('fontSize', button.dataset.fontSize);
        }));
        modalRoot.querySelectorAll('[data-density]').forEach((button) => button.addEventListener('click', () => {
            setPreference('density', button.dataset.density);
        }));
        petMotion.addEventListener('change', () => setPreference('petMotion', petMotion.checked));
        launcherReset.addEventListener('click', () => {
            try { localStorage.removeItem('afd_ai_chat_launcher_position'); } catch (error) {}
            launcherReset.classList.add('is-confirmed');
            window.setTimeout(() => launcherReset.classList.remove('is-confirmed'), 900);
        });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (preferences.theme === 'system') applyPreferences();
        });

        applyPreferences();
        syncSendButton();
        window.setInterval(() => { if (opened && !document.hidden && settings.hidden) loadMessages(); }, 2500);
        window.addEventListener('beforeunload', () => realtime?.destroy(), { once: true });
    };
});
