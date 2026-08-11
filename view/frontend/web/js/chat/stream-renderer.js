/** Incremental, append-only Markdown rendering for live assistant output. */
(function (modules) {
    'use strict';

    modules.streamRendererMethods = function (context) {
        const { sanitizeHtml, sanitizeStreamingHtml } = context.helpers;
        const rendererStates = new Map();
        let scrollFrame = null;

        const partKey = part => String(part?.id || '');
        const markdown = () => window.AfdStreamingMarkdown || null;
        const safeHref = value => /^(?:https?:|mailto:|tel:|\/)/i.test(String(value || '').trim());
        const safeSource = value => /^(?:https?:|\/)/i.test(String(value || '').trim());

        const createSafeRenderer = (library, element) => {
            const renderer = library.default_renderer(element);
            const setAttribute = renderer.set_attr;

            renderer.set_attr = (data, attribute, rawValue) => {
                let value = String(rawValue || '').trim();
                if (attribute === library.HREF && !safeHref(value)) return;
                if (attribute === library.SRC && !safeSource(value)) return;
                if (attribute === library.LANG) {
                    value = value.replace(/[^a-z0-9+#._-]/gi, '').slice(0, 40);
                }

                setAttribute(data, attribute, value);
                const node = data?.nodes?.[data.index];
                if (attribute === library.HREF && node instanceof HTMLElement) {
                    node.classList.add('afd-ai-chat__message-link');
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                }
                if (attribute === library.SRC && node instanceof HTMLImageElement) {
                    node.loading = 'lazy';
                    node.decoding = 'async';
                }
            };

            return renderer;
        };

        return {
            createStreamingTextPart(content = '') {
                return {
                    id: Date.now() + Math.random(),
                    type: 'text',
                    raw: String(content || ''),
                    html: '',
                    streaming: true
                };
            },

            mountStreamingMarkdown(element, part) {
                if (!element || !part || part.streaming !== true) return;
                const library = markdown();
                if (!library?.parser || !library?.default_renderer) {
                    part.html = sanitizeStreamingHtml(part.raw || '');
                    part.streaming = false;
                    return;
                }

                const key = partKey(part);
                element.textContent = '';
                const renderer = createSafeRenderer(library, element);
                const state = {
                    element,
                    library,
                    parser: library.parser(renderer),
                    renderedLength: 0
                };
                rendererStates.set(key, state);

                const raw = String(part.raw || '');
                if (raw) {
                    library.parser_write(state.parser, raw);
                    state.renderedLength = raw.length;
                }
                this.scheduleStreamingScroll();
            },

            appendStreamingText(part, content = '') {
                if (!part) return;
                const next = String(content || '');
                if (!next) return;

                part.raw = String(part.raw || '') + next;
                const state = rendererStates.get(partKey(part));
                if (!state) return;

                try {
                    const unrendered = part.raw.slice(state.renderedLength);
                    if (unrendered) {
                        state.library.parser_write(state.parser, unrendered);
                        state.renderedLength = part.raw.length;
                    }
                } catch (error) {
                    rendererStates.delete(partKey(part));
                    part.html = sanitizeStreamingHtml(part.raw || '');
                    part.streaming = false;
                }
                this.scheduleStreamingScroll();
            },

            finalizeStreamingText(part) {
                if (!part || part.type !== 'text') return;
                const state = rendererStates.get(partKey(part));
                if (state) {
                    try {
                        const unrendered = String(part.raw || '').slice(state.renderedLength);
                        if (unrendered) state.library.parser_write(state.parser, unrendered);
                        state.library.parser_end(state.parser);
                    } catch (error) {}
                    rendererStates.delete(partKey(part));
                }

                // The complete pass adds the existing code toolbar, syntax
                // highlighting and hardened link treatment exactly once.
                part.html = sanitizeHtml(part.raw || '');
                part.streaming = false;
            },

            disposeStreamingMessage(message) {
                (Array.isArray(message?.parts) ? message.parts : []).forEach(part => {
                    if (part?.type === 'text') rendererStates.delete(partKey(part));
                });
            },

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
