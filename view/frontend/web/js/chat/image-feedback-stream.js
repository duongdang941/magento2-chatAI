/** Image generation and message feedback stream methods for the storefront chat Alpine component. */
(function (modules) {
    'use strict';

    modules.imageFeedbackStreamMethods = function (context) {
        const { config, urls } = context;
        const {
            sanitizeHtml,
            sanitizeCustomerResponseText,
            sanitizeStreamingHtml,
            getBrowserFormKey,
            resolveWebSocketUrl,
            postFeedback,
            mergeProductGridHtml,
            mergeProductPayload,
            utf8ByteLength,
            MAX_WEBSOCKET_PAYLOAD_BYTES
        } = context.helpers;

        return {
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
                    await postFeedback(urls.feedback, {
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
                    await postFeedback(urls.feedback, {
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
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));