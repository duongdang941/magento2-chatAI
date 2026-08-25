/** Reasoning, thinking, and activity stream methods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.reasoningStreamMethods = function (context) {
        const { config, urls } = context;
        const {
            sanitizeHtml,
            sanitizeCustomerResponseText,
            sanitizeStreamingHtml,
            getBrowserFormKey,
            resolveWebSocketUrl
        } = context.helpers;

        return {
            toggleReasoning(part) {
                if (part) {
                    const nextExpanded = part.isExpanded === false;
                    part.wasManuallyToggled = true;
                    part.isManuallyCollapsed = !nextExpanded;
                    part.isExpanded = nextExpanded;
                    this.scheduleGuestSessionSnapshot?.();
                }
            },

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

            markReasoningResumed() {
                const part = this.currentLiveReasoningPart();
                if (part) {
                    part.autoCollapsed = false;
                    part.elapsedMs = null;
                    if (part.isManuallyCollapsed !== true) {
                        part.isExpanded = true;
                    }
                }
            },

            isProviderReasoningStep(event) {
                // Provider chain-of-thought is never a storefront event. Older
                // persisted messages may still contain it, so filtering here
                // prevents a history reload from exposing it again.
                return false;
            },

            isVisibleReasoningEvent(event) {
                return event?.type === 'activity'
                    || this.isProviderReasoningStep(event);
            },

            appendProviderReasoningDelta(data) {
                // Intentionally ignored. Verified tool actions below provide
                // the concise Codex-style progress that a shopper can trust.
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
                    .filter(event => event?.type === 'activity');
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
                        isExpanded: true,
                        isManuallyCollapsed: false,
                        wasManuallyToggled: false,
                        autoCollapsed: false
                    };
                    message.parts.unshift(reasoningPart);
                }

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
                    const elapsed = this.formatElapsedMs(part.elapsedMs);
                    // A zero-second duration is timing noise, not useful work.
                    return elapsed
                        ? this.t('thought_for', { 1: elapsed })
                        : (this.reasoningSummary(part) || this.t('thought_process'));
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
                return [];
            },

            reasoningTimeline(part) {
                if (!part) return [];
                const events = Array.isArray(part.events) ? part.events : [];
                if (events.length > 0) return events.filter(event => event?.type === 'activity');
                const activities = (Array.isArray(part.activities) ? part.activities : [])
                    .map(activity => ({ ...activity, type: 'activity' }));
                return activities;
            },

            activityDurationLabel(activity) {
                // The action itself explains the work. A live duration adds
                // visual noise and makes a delayed Magento request look like
                // a broken customer-facing status.
                return '';
            },

            activitySummaryLabel(part) {
                const activities = this.reasoningActivities(part);
                const latest = activities.slice(-1)[0];
                if (latest) return this.toolActivityLabel(latest);
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
                const elapsed = this.formatElapsedMs(Math.max(
                    0,
                    Number(message?.workedForMs) || 0,
                    Number(message?.worked_for_ms) || 0
                ));
                return elapsed ? this.t('worked_for', { 1: elapsed }) : '';
            },

            turnWorkSummary(part) {
                const activities = this.reasoningActivities(part);
                const latest = activities.slice(-1)[0];
                const summary = String(latest?.turn_summary || '').replace(/\s+/g, ' ').trim();
                // The gateway validates this model-provided template and
                // binds it to the shopper language. The browser only expands
                // the duration token; it never supplies a hard-coded language
                // for a current, localized action.
                return summary.length >= 12
                    && summary.length <= 120
                    && (summary.match(/\{duration\}/g) || []).length === 1
                    && !/[<>`]/.test(summary)
                    && !/(?:https?:\/\/|www\.)/i.test(summary)
                    ? summary
                    : '';
            },

            turnWorkLabel(part, elapsedMs = 0, isLive = false) {
                const elapsed = this.formatElapsedMs(elapsedMs);
                // This row represents the whole assistant turn, never one
                // individual tool action. The action labels belong exclusively
                // in the expanded timeline below it.
                const localizedSummary = this.turnWorkSummary(part);
                if (elapsed && localizedSummary) {
                    return localizedSummary.replace('{duration}', elapsed);
                }
                return elapsed
                    ? this.t(isLive ? 'working_for' : 'worked_for', { 1: elapsed })
                    : this.t(isLive ? 'working' : 'actions_checked_1');
            },

            turnDividerLabel(msg, index = null) {
                if (!msg || msg.deleted) return '';
                const isLiveTurn = this.isLoading
                    && index !== null
                    && index === this.currentAiMessageIndex;
                if (isLiveTurn) {
                    const liveReasoning = this.currentLiveReasoningPart();
                    const startedAt = Number(this.responseStartedAt) || 0;
                    if (!startedAt) return '';
                    const now = Number(this.streamNow) || Date.now();
                    return this.turnWorkLabel(liveReasoning, Math.max(0, now - startedAt), true);
                }
                const reasoning = (Array.isArray(msg.parts) ? msg.parts : [])
                    .find(part => part?.type === 'reasoning');
                if (reasoning) {
                    const elapsedMs = Math.max(
                        0,
                        Number(msg.workedForMs) || 0,
                        Number(msg.worked_for_ms) || 0,
                        Number(reasoning.elapsedMs) || 0
                    );
                    return this.turnWorkLabel(reasoning, elapsedMs, false);
                }
                return this.workedForLabel(msg);
            },

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
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
