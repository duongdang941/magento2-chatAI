/** Markdown-library rendering for live assistant output. */
(function (modules) {
    'use strict';

    modules.streamRendererMethods = function (context) {
        const { sanitizeHtml, sanitizeStreamingHtml } = context.helpers;
        let scrollFrame = null;
        let markdownRenderFrame = null;
        const pendingMarkdownParts = new Set();

        const renderStreamingMarkdown = () => {
            markdownRenderFrame = null;
            pendingMarkdownParts.forEach((part) => {
                // `marked` owns the Markdown syntax. The helper also defers
                // incomplete link syntax until it is safe to show to shoppers.
                part.html = sanitizeStreamingHtml(part.raw);
            });
            pendingMarkdownParts.clear();
        };

        const queueStreamingMarkdownRender = (part) => {
            if (!part) return;
            pendingMarkdownParts.add(part);
            if (markdownRenderFrame !== null) return;

            if (typeof window.requestAnimationFrame !== 'function') {
                renderStreamingMarkdown();
                return;
            }
            markdownRenderFrame = window.requestAnimationFrame(renderStreamingMarkdown);
        };

        return {
            createStreamingTextPart(content = '') {
                const part = {
                    id: Date.now() + Math.random(),
                    type: 'text',
                    raw: String(content || ''),
                    html: '',
                    streaming: true
                };
                queueStreamingMarkdownRender(part);
                return part;
            },

            appendStreamingText(part, content = '') {
                if (!part) return;
                const next = String(content || '');
                if (!next) return;

                part.raw = String(part.raw || '') + next;
                queueStreamingMarkdownRender(part);
                this.scheduleStreamingScroll();
            },

            finalizeStreamingText(part) {
                if (!part || part.type !== 'text') return;
                pendingMarkdownParts.delete(part);
                // Re-render once after the final token so `marked` can turn
                // the whole completed Markdown document into its final DOM.
                part.html = sanitizeHtml(part.raw);
                part.streaming = false;
            },

            disposeStreamingMessage() {},

            scheduleStreamingScroll() {
                if (scrollFrame !== null || typeof window.requestAnimationFrame !== 'function') return;
                scrollFrame = window.requestAnimationFrame(() => {
                    scrollFrame = null;
                    this.scrollToBottom();
                });
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
