/** Markdown-library rendering for live assistant output. */
(function (modules) {
    'use strict';

    modules.streamRendererMethods = function (context) {
        const { sanitizeHtml, sanitizeStreamingHtmlBlocks, splitHtmlBlocks } = context.helpers;
        let scrollFrame = null;
        let markdownRenderFrame = null;
        const pendingMarkdownParts = new Set();

        // Codex streams markdown as staggered segments: existing segments
        // keep their DOM node, only newly completed blocks fade in with a
        // small `--fade-delay` stagger. Blocks here are blank-line separated
        // paragraphs; the streaming stabilizer guarantees every block but the
        // last is complete, so earlier blocks' HTML is byte-stable between
        // frames and the diff never re-animates finished content.
        const FADE_STAGGER_MS = 60;

        const renderStreamingMarkdown = function () {
            markdownRenderFrame = null;
            // A provider can deliver several deltas between two browser
            // frames. Render the latest complete raw value once per frame.
            // The old displayedLength interpolation intentionally left the
            // bubble behind the provider queue, which made fast responses
            // look like they were freezing and then catching up.
            const parts = Array.from(pendingMarkdownParts);
            pendingMarkdownParts.clear();
            let renderedContent = false;

            parts.forEach((part) => {
                // `done` can finalize a part while a render frame is queued.
                // Never overwrite the final, fully sanitized HTML with a
                // stale streaming render in that case.
                if (!part || part.streaming === false) return;
                const raw = String(part.raw || '');
                part.blocks = sanitizeStreamingHtmlBlocks(raw);
                part.html = part.blocks.join('');
                renderedContent = renderedContent || raw.length > 0;
            });

            if (pendingMarkdownParts.size > 0 && typeof window.requestAnimationFrame === 'function') {
                markdownRenderFrame = window.requestAnimationFrame(renderStreamingMarkdown);
            }

            if (renderedContent && typeof this?.scheduleStreamingScroll === 'function') {
                this.scheduleStreamingScroll();
            }
        };

        const queueStreamingMarkdownRender = function (part, scope) {
            if (!part) return;
            pendingMarkdownParts.add(part);
            if (markdownRenderFrame !== null) return;

            const boundRender = renderStreamingMarkdown.bind(scope);
            if (typeof window.requestAnimationFrame !== 'function') {
                boundRender();
                return;
            }
            markdownRenderFrame = window.requestAnimationFrame(boundRender);
        };

        const buildBlockNode = function (blockHtml) {
            const container = document.createElement('div');
            container.innerHTML = blockHtml;
            // Streaming blocks are inline runs (plain text with
            // <strong>/<br> mixed in) and have no single root element —
            // taking firstElementChild would silently drop the surrounding
            // text. Only unwrap when the block really is one element;
            // otherwise wrap the whole run in a span.
            if (container.childNodes.length === 1 && container.children.length === 1) {
                return container.children[0];
            }
            const wrapper = document.createElement('span');
            wrapper.className = 'afd-ai-chat__stream-block';
            while (container.firstChild) {
                wrapper.appendChild(container.firstChild);
            }
            return wrapper;
        };

        return {
            createStreamingTextPart(content = '') {
                const initialText = String(content || '');
                const part = {
                    id: Date.now() + Math.random(),
                    type: 'text',
                    raw: initialText,
                    html: '',
                    blocks: [],
                    streaming: true
                };
                queueStreamingMarkdownRender(part, this);
                return part;
            },

            appendStreamingText(part, chunk = '') {
                if (!part) return;
                part.raw = (part.raw || '') + String(chunk || '');
                queueStreamingMarkdownRender(part, this);
            },

            finalizeStreamingText(part) {
                if (!part) return;
                pendingMarkdownParts.delete(part);
                part.streaming = false;
                part.html = sanitizeHtml(part.raw || '');
                // Keep the block projection for the final render. Unchanged
                // paragraphs survive the streaming→final sanitizer swap
                // without a repaint; changed blocks fade in like new ones,
                // which masks the tier switch instead of snapping the whole
                // bubble.
                part.blocks = splitHtmlBlocks(part.html);
                if (typeof this.scheduleStreamingScroll === 'function') {
                    this.scheduleStreamingScroll();
                }
            },

            scheduleStreamingScroll() {
                if (scrollFrame !== null) return;
                const scroll = () => {
                    scrollFrame = null;
                    // The chat shell owns following: it waits for Alpine's
                    // DOM work and observes subsequent content-height changes
                    // (Markdown blocks, images, etc.). A direct scroll here
                    // races that rendering and is why streaming could stop
                    // just above the newest line.
                    if (typeof this.scrollToBottom === 'function') {
                        this.scrollToBottom();
                    }
                };
                if (typeof window.requestAnimationFrame !== 'function') {
                    scroll();
                    return;
                }
                scrollFrame = window.requestAnimationFrame(scroll);
            },

            patchMessageHtml(element, htmlContent, animateNewBlocks = true) {
                if (!element) return;

                // History-loaded messages arrive as one pre-sanitized string.
                if (!Array.isArray(htmlContent)) {
                    const nextHtml = String(htmlContent || '');
                    if (element.innerHTML !== nextHtml) {
                        element.innerHTML = nextHtml;
                    }
                    delete element.dataset.renderedBlocks;
                    return;
                }

                const nextBlocks = htmlContent.filter(block => String(block || '').trim().length > 0);
                const previousCount = Number(element.dataset.renderedBlocks || 0);
                const signature = nextBlocks.join('\u0000');
                if (element.dataset.blockSignature === signature) return;

                let appended = 0;
                nextBlocks.forEach((blockHtml, index) => {
                    const existing = element.children[index];
                    if (existing && existing.dataset.blockHtml === blockHtml) {
                        return; // Stable block: keep its DOM untouched.
                    }
                    const node = buildBlockNode(blockHtml);
                    node.dataset.blockHtml = blockHtml;
                    const isNewBlock = index >= previousCount;
                    if (animateNewBlocks && isNewBlock) {
                        node.classList.add('afd-ai-chat__block-fade');
                        node.style.setProperty('--fade-delay', `${Math.min(appended, 3) * FADE_STAGGER_MS}ms`);
                        appended += 1;
                    }
                    if (existing) {
                        element.replaceChild(node, existing);
                    } else {
                        element.appendChild(node);
                    }
                });

                while (element.children.length > nextBlocks.length) {
                    element.removeChild(element.lastElementChild);
                }

                element.dataset.blockSignature = signature;
                element.dataset.renderedBlocks = String(nextBlocks.length);
            }
        };
    };
})(window.AfdAiChat = window.AfdAiChat || {});
