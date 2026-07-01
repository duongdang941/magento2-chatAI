/** preferenceMethods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.preferenceMethods = function (context) {
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
            openSettings() {
                this.closeMobileSidebar();
                this.closeHistorySearch(false);
                this.isSettingsOpen = true;
            },

            closeSettings() {
                this.isSettingsOpen = false;
            },

            restoreUiSettings() {
                try {
                    const raw = localStorage.getItem(this.uiSettingsStorageKey);
                    if (!raw) return;
                    const saved = JSON.parse(raw);
                    if (!saved || typeof saved !== 'object') return;
                    const savedAccent = typeof saved.accent === 'string' ? saved.accent.toLowerCase() : '';
                    // Migrate only the former default. Deliberately selected custom
                    // colours remain under the customer's control.
                    const accent = savedAccent === '#5e6ad2' ? '#c32654' : saved.accent;
                    const glassOpacity = this.normalizeGlassOpacity(saved.glassOpacity);
                    this.uiSettings = {
                        ...this.uiSettings,
                        theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : this.uiSettings.theme,
                        accent: /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : this.uiSettings.accent,
                        glassOpacity,
                        fontSize: ['small', 'medium', 'large'].includes(saved.fontSize) ? saved.fontSize : this.uiSettings.fontSize,
                        density: ['comfortable', 'compact'].includes(saved.density) ? saved.density : this.uiSettings.density,
                        petMotion: saved.petMotion !== false
                    };
                } catch (e) {}
            },

            saveUiSettings() {
                try {
                    localStorage.setItem(this.uiSettingsStorageKey, JSON.stringify({
                        theme: this.uiSettings.theme,
                        accent: this.uiSettings.accent,
                        glassOpacity: this.normalizeGlassOpacity(this.uiSettings.glassOpacity),
                        fontSize: this.uiSettings.fontSize,
                        density: this.uiSettings.density,
                        petMotion: this.uiSettings.petMotion
                    }));
                } catch (e) {}
            },

            setUiSetting(key, value) {
                const normalizedValue = key === 'glassOpacity'
                    ? this.normalizeGlassOpacity(value)
                    : value;
                this.uiSettings = {
                    ...this.uiSettings,
                    [key]: normalizedValue
                };
                this.saveUiSettings();
                this.applyUiSettings();
                this.$nextTick(() => this.resizeComposerInput());
                if (key === 'petMotion') {
                    this.stopPetAnimation();
                    this.$nextTick(() => this.syncPetAnimation());
                }
            },

            resolvedUiTheme() {
                if (this.uiSettings.theme !== 'system') return this.uiSettings.theme;
                if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches) {
                    return 'light';
                }
                return 'dark';
            },

            messageSpacingHelp() {
                return this.uiSettings.density === 'compact'
                    ? 'Compact layout: 6px between messages.'
                    : 'Roomy layout: 28px between messages.';
            },

            normalizeGlassOpacity(value) {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) return 100;
                return Math.min(100, Math.max(0, Math.round(numeric)));
            },

            glassOpacityLabel() {
                return `${this.normalizeGlassOpacity(this.uiSettings.glassOpacity)}%`;
            },

            accentContrast(color) {
                const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color || ''));
                if (!match) return '#ffffff';
                const red = parseInt(match[1], 16);
                const green = parseInt(match[2], 16);
                const blue = parseInt(match[3], 16);
                const brightness = ((red * 299) + (green * 587) + (blue * 114)) / 1000;
                return brightness >= 150 ? '#171717' : '#ffffff';
            },

            applyUiSettings() {
                if (!this.$el) return;
                this.$el.setAttribute('data-ui-theme', this.resolvedUiTheme());
                this.$el.setAttribute('data-ui-density', this.uiSettings.density);
                this.$el.setAttribute('data-ui-font-size', this.uiSettings.fontSize);
                this.$el.setAttribute(
                    'data-ui-glass',
                    this.normalizeGlassOpacity(this.uiSettings.glassOpacity) < 100 ? 'true' : 'false'
                );
            },

            rootStyle() {
                const glassOpacity = this.normalizeGlassOpacity(this.uiSettings.glassOpacity) / 100;
                return {
                    ...this.launcherStyle(),
                    '--afd-chat-accent-live': this.uiSettings.accent,
                    '--afd-chat-accent-contrast-live': this.accentContrast(this.uiSettings.accent),
                    '--afd-chat-glass-alpha': glassOpacity.toFixed(2),
                    '--afd-chat-glass-content-alpha': Math.min(0.94, Math.max(0.46, glassOpacity + 0.18)).toFixed(2)
                };
            },

            async exportChatData() {
                if (this.privacyBusy || !urls.privacy) return;
                this.privacyBusy = true;
                this.privacyNotice = '';
                try {
                    const data = await this.requestChatPrivacyAction({ action: 'export' });
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = `store-assistant-data-${new Date().toISOString().slice(0, 10)}.json`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(link.href);
                    this.privacyNotice = 'Your chat data export is ready.';
                    this.privacyNoticeVariant = 'success';
                } catch (error) {
                    this.privacyNotice = error.message || 'Your chat data could not be exported.';
                    this.privacyNoticeVariant = 'error';
                } finally {
                    this.privacyBusy = false;
                }
            },

            async deleteChatData() {
                if (!this.privacyDeleteArmed) {
                    this.privacyDeleteArmed = true;
                    this.privacyNotice = 'Select Delete again to permanently remove your chat history.';
                    this.privacyNoticeVariant = 'warning';
                    return;
                }
                if (this.privacyBusy || !urls.privacy) return;
                this.privacyBusy = true;
                try {
                    await this.requestChatPrivacyAction({ action: 'delete', confirmation: 'DELETE' });
                    if (!this.isLoggedIn && this.socket && this.wsConnected) {
                        this.socket.send(JSON.stringify({ action: 'reset_guest_history' }));
                    }
                    this.privacyDeleteArmed = false;
                    this.closeSettings();
                    this.startNewChat(false);
                    this.conversations = [];
                    this.privacyNotice = '';
                    this.broadcastCrossTabEvent('new_chat');
                } catch (error) {
                    this.privacyNotice = error.message || 'Your chat data could not be deleted.';
                    this.privacyNoticeVariant = 'error';
                } finally {
                    this.privacyBusy = false;
                }
            },

            async requestChatPrivacyAction(payload) {
                const response = await fetch(urls.privacy, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Form-Key': getBrowserFormKey()
                    },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                if (!response.ok || result.status !== 'success') {
                    throw new Error(result.message || 'The privacy request could not be completed.');
                }
                return result;
            },
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
