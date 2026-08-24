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