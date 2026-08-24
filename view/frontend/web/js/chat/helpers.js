/** Shared, dependency-free helpers for the storefront chat modules. */
(function (modules) {
    'use strict';

    function enhanceMarkdownCodeBlocks(html) {
        const container = document.createElement('div');
        container.innerHTML = html;

        container.querySelectorAll('pre > code').forEach(code => {
            const pre = code.parentElement;
            if (!pre || pre.parentElement?.classList.contains('afd-ai-chat__code-block')) return;

            const languageClass = Array.from(code.classList).find(className => className.indexOf('language-') === 0);
            let language = languageClass ? languageClass.slice(9).replace(/[^a-z0-9+#.-]/gi, '') : '';
            const source = code.textContent || '';

            if (window.hljs && source.trim()) {
                try {
                    const result = language && window.hljs.getLanguage(language)
                        ? window.hljs.highlight(source, { language, ignoreIllegals: true })
                        : window.hljs.highlightAuto(source);
                    code.innerHTML = result.value;
                    if (!language && result.language) language = result.language;
                } catch (e) { }
            }

            code.classList.add('hljs');

            const block = document.createElement('div');
            block.className = 'afd-ai-chat__code-block';
            if (language) block.dataset.codeLanguage = language;

            const toolbar = document.createElement('div');
            toolbar.className = 'afd-ai-chat__code-toolbar';

            const label = document.createElement('span');
            label.className = 'afd-ai-chat__code-language';
            label.textContent = language || 'Code';

            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.className = 'afd-ai-chat__code-copy';
            copyButton.setAttribute('data-code-copy', 'true');
            copyButton.setAttribute('aria-label', 'Copy code');
            copyButton.setAttribute('title', 'Copy code');
            copyButton.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';

            toolbar.append(label, copyButton);
            pre.replaceWith(block);
            block.append(toolbar, pre);
        });

        return container.innerHTML;
    }

    function isEscaped(source, index) {
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
            slashCount += 1;
        }
        return slashCount % 2 === 1;
    }

    function findMatchingDelimiter(source, openingIndex, opening, closing) {
        let depth = 0;
        for (let cursor = openingIndex; cursor < source.length; cursor += 1) {
            if (isEscaped(source, cursor)) continue;
            if (source[cursor] === opening) depth += 1;
            if (source[cursor] === closing) {
                depth -= 1;
                if (depth === 0) return cursor;
            }
        }
        return -1;
    }

    function isInsideCodeSpan(source, index) {
        let delimiterCount = 0;
        for (let cursor = 0; cursor < index; cursor += 1) {
            if (source[cursor] === '`' && !isEscaped(source, cursor)) {
                delimiterCount += 1;
            }
        }
        return delimiterCount % 2 === 1;
    }

    /**
     * Return the opening position of a Markdown inline entity which is
     * still incomplete. A stream can stop after `[label`, `[label]`, or
     * `[label](url`; all three must remain out of the DOM so the shopper
     * never sees raw Markdown briefly turn into an anchor.
     */
    function findIncompleteMarkdownEntity(source) {
        for (let cursor = 0; cursor < source.length; cursor += 1) {
            if (source[cursor] !== '[' || isEscaped(source, cursor) || isInsideCodeSpan(source, cursor)) {
                continue;
            }

            const entityStart = cursor > 0 && source[cursor - 1] === '!' && !isEscaped(source, cursor - 1)
                ? cursor - 1
                : cursor;
            const labelEnd = findMatchingDelimiter(source, cursor, '[', ']');
            if (labelEnd === -1) return entityStart;

            const destinationOpening = labelEnd + 1;
            if (destinationOpening === source.length) return entityStart;
            if (source[destinationOpening] !== '(') continue;

            if (findMatchingDelimiter(source, destinationOpening, '(', ')') === -1) {
                return entityStart;
            }
        }
        return -1;
    }

    function isInsideCompletedMarkdownDestination(source, index) {
        for (let cursor = source.lastIndexOf('[', index); cursor !== -1; cursor = source.lastIndexOf('[', cursor - 1)) {
            if (isEscaped(source, cursor)) continue;
            const labelEnd = findMatchingDelimiter(source, cursor, '[', ']');
            const destinationOpening = labelEnd + 1;
            if (labelEnd === -1 || source[destinationOpening] !== '(') continue;

            const destinationEnd = findMatchingDelimiter(source, destinationOpening, '(', ')');
            if (destinationEnd !== -1 && index > destinationOpening && index < destinationEnd) {
                return true;
            }
        }
        return false;
    }

    function findUnclosedMarkdownDelimiter(source, delimiter) {
        let openingIndex = -1;
        let cursor = 0;

        while (cursor < source.length) {
            const index = source.indexOf(delimiter, cursor);
            if (index === -1) break;
            if (isEscaped(source, index)) {
                cursor = index + delimiter.length;
                continue;
            }

            if (delimiter === '*' || delimiter === '_') {
                const before = source[index - 1] || '\n';
                const after = source[index + delimiter.length] || '';
                // A '**'/'__' run is owned by the double-delimiter scan.
                // Counting its inner characters as single emphasis flagged
                // closed bold spans as unterminated and truncated them
                // mid-stream ("Second **complete**" → "Second **complete").
                if (before === delimiter || source[index + 1] === delimiter) {
                    cursor = index + delimiter.length;
                    continue;
                }
                // A list marker (`* item`) only occurs at the start of a
                // line; a closing emphasis delimiter followed by a space is
                // valid mid-sentence. Underscores inside an identifier
                // (`snake_case`) are not emphasis delimiters either.
                if ((/\s/u.test(after) && (index === 0 || before === '\n'))
                    || (delimiter === '_' && /[\p{L}\p{M}\p{N}]/u.test(before)
                        && /[\p{L}\p{M}\p{N}]/u.test(after))) {
                    cursor = index + delimiter.length;
                    continue;
                }
            }

            // A triple-backtick fence owns its three characters. Do not
            // count those same characters again as three inline code spans.
            if (delimiter === '`' && source.startsWith('```', index)) {
                cursor = index + 3;
                continue;
            }

            openingIndex = openingIndex === -1 ? index : -1;
            cursor = index + delimiter.length;
        }

        return openingIndex;
    }

    /**
     * Keep Markdown delimiters out of the live DOM until their pair arrives.
     * The final renderer can safely parse the complete source, while the
     * streaming fallback must not briefly show `**`, backticks, or `~~` as
     * customer-visible text and then rewrite them after the next delta.
     */
    function findIncompleteMarkdownFormatting(source) {
        const starts = [
            findUnclosedMarkdownDelimiter(source, '```'),
            findUnclosedMarkdownDelimiter(source, '`'),
            findUnclosedMarkdownDelimiter(source, '**'),
            findUnclosedMarkdownDelimiter(source, '__'),
            findUnclosedMarkdownDelimiter(source, '~~'),
            findUnclosedMarkdownDelimiter(source, '*'),
            findUnclosedMarkdownDelimiter(source, '_')
        ].filter(index => index >= 0);

        return starts.length > 0 ? Math.min(...starts) : -1;
    }

    /**
     * Markdown is delivered token-by-token. Keep an entity in a buffer
     * until its complete syntax is present, then render its whole range as
     * one component. `raw` remains untouched and is rendered in full once
     * streaming finishes.
     */
    function stabilizeStreamingMarkdown(rawText) {
        const source = String(rawText || '');
        let cutoff = source.length;

        const incompleteEntityStart = findIncompleteMarkdownEntity(source);
        if (incompleteEntityStart !== -1) {
            cutoff = Math.min(cutoff, incompleteEntityStart);
        }

        const incompleteFormattingStart = findIncompleteMarkdownFormatting(source);
        if (incompleteFormattingStart !== -1) {
            cutoff = Math.min(cutoff, incompleteFormattingStart);
        }

        const unfinishedAutolink = source.match(/<https?:\/\/[^\s>]*$/i);
        if (unfinishedAutolink && typeof unfinishedAutolink.index === 'number') {
            cutoff = Math.min(cutoff, unfinishedAutolink.index);
        }

        // A bare URL has no stable text boundary while it is still being
        // streamed. Deferring it avoids the visual URL-to-link rewrite;
        // complete messages retain the original URL as a normal link.
        const trailingUrl = source.match(/(?:https?:\/\/|www\.)[^\s<>]*$/i);
        if (trailingUrl && typeof trailingUrl.index === 'number') {
            const isCompletedMarkdownDestination = isInsideCompletedMarkdownDestination(source, trailingUrl.index);
            if (!isCompletedMarkdownDestination) {
                cutoff = Math.min(cutoff, trailingUrl.index);
            }
        }

        let stableSource = source.slice(0, cutoff);
        return stableSource;
    }

    // Copy the customer-facing text, not the transport Markdown or the
    // widget's action markup. Links keep their visible label, while code
    // keeps its contents without the surrounding Markdown fences.
    function normalizeMarkdownForCopy(rawText) {
        return String(rawText || '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/```[^\n]*\r?\n([\s\S]*?)```/g, '$1')
            .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g, '$1')
            .replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/gi, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function enhanceMarkdownLinks(html) {
        const container = document.createElement('div');
        container.innerHTML = html;

        container.querySelectorAll('a').forEach(link => {
            const href = String(link.getAttribute('href') || '').trim();
            const isSafe = /^(?:https?:|mailto:|tel:|\/)/i.test(href);
            if (!isSafe) {
                link.replaceWith(document.createTextNode(link.textContent || ''));
                return;
            }

            link.classList.add('afd-ai-chat__message-link');
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        });

        return container.innerHTML;
    }

    function enhanceBareTextLinks(html) {
        const container = document.createElement('div');
        container.innerHTML = html;
        const walker = document.createTreeWalker(container, 4);
        const textNodes = [];
        let currentNode;

        while ((currentNode = walker.nextNode())) {
            const parent = currentNode.parentElement;
            if (!parent || parent.closest('a, code, pre, script, style, .afd-ai-chat__code-block')) {
                continue;
            }
            if (/(?:https?:\/\/|www\.)/i.test(currentNode.nodeValue || '')) {
                textNodes.push(currentNode);
            }
        }

        textNodes.forEach((textNode) => {
            const source = textNode.nodeValue || '';
            const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            let changed = false;
            let match;

            while ((match = urlPattern.exec(source))) {
                const rawUrl = match[0];
                const visibleUrl = rawUrl.replace(/[.,!?;:'"\)\]\}]+$/g, '');
                if (!visibleUrl) continue;

                const start = match.index;
                const end = start + visibleUrl.length;
                if (start > cursor) {
                    fragment.appendChild(document.createTextNode(source.slice(cursor, start)));
                }

                const anchor = document.createElement('a');
                anchor.className = 'afd-ai-chat__message-link';
                anchor.href = /^www\./i.test(visibleUrl) ? `https://${visibleUrl}` : visibleUrl;
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                anchor.textContent = visibleUrl;
                fragment.appendChild(anchor);
                if (end < start + rawUrl.length) {
                    fragment.appendChild(document.createTextNode(rawUrl.slice(visibleUrl.length)));
                }
                cursor = end;
                changed = true;
            }

            if (!changed) return;
            if (cursor < source.length) {
                fragment.appendChild(document.createTextNode(source.slice(cursor)));
            }
            textNode.replaceWith(fragment);
        });

        return container.innerHTML;
    }

    function getMarkedParser() {
        if (typeof window !== 'undefined') {
            if (window.marked && typeof window.marked.parse === 'function') {
                return window.marked;
            }
            if (typeof window.require === 'function') {
                try {
                    if (window.require.defined && window.require.defined('marked')) {
                        const m = window.require('marked');
                        if (m && typeof m.parse === 'function') {
                            window.marked = m;
                            return m;
                        }
                    }
                } catch (e) { }
            }
        }
        if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
            return marked;
        }
        return null;
    }

    function getDomPurify() {
        if (typeof window !== 'undefined') {
            if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
                return window.DOMPurify;
            }
            if (typeof window.require === 'function') {
                try {
                    if (window.require.defined && window.require.defined('DOMPurify')) {
                        const p = window.require('DOMPurify');
                        if (p && typeof p.sanitize === 'function') {
                            window.DOMPurify = p;
                            return p;
                        }
                    }
                } catch (e) { }
            }
        }
        if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
            return DOMPurify;
        }
        return null;
    }

    function normalizeMarkdownWhitespace(text) {
        return String(text || '')
            .replace(/(\*\*[^*\n]+\*\*)\s*\n{2,}/g, '$1\n')
            .replace(/(\r?\n){3,}/g, '\n\n');
    }

    function parseBasicMarkdownFallback(text) {
        let clean = normalizeMarkdownWhitespace(text);
        let result = escapeHtml(clean);
        // Bold: **text** or __text__
        result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');
        // Italic: *text* or _text_
        result = result.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        result = result.replace(/_([^_\n]+)_/g, '<em>$1</em>');
        // Markdown link: [label](url)
        result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="afd-ai-chat__message-link">$1</a>');
        // Linebreaks: collapse double newlines after bold title
        result = result.replace(/(<strong>.+?<\/strong>)\s*<br\s*\/?>\s*<br\s*\/?>/gi, '$1<br>');
        result = result.replace(/\r?\n/g, '<br>');
        result = result.replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>');
        // Horizontal rule: ---
        result = result.replace(/(?:^|<br\s*\/?>)\s*---+\s*(?=<br\s*\/?>|$)/gi, '<hr class="afd-ai-chat__hr">');
        return result;
    }

    function renderMarkdownWithParser(text) {
        const parser = getMarkedParser();
        const cleanText = normalizeMarkdownWhitespace(text);
        if (!parser) return parseBasicMarkdownFallback(cleanText);
        try {
            if (typeof parser.parse === 'function') {
                return parser.parse(cleanText, { breaks: true, gfm: true });
            }
            if (typeof parser === 'function') {
                return parser(cleanText, { breaks: true, gfm: true });
            }
            if (parser.marked && typeof parser.marked.parse === 'function') {
                return parser.marked.parse(cleanText, { breaks: true, gfm: true });
            }
            if (parser.default && typeof parser.default.parse === 'function') {
                return parser.default.parse(cleanText, { breaks: true, gfm: true });
            }
        } catch (e) {
            console.warn('[AFD-AI-CHAT] Markdown parser error, falling back:', e);
        }
        return parseBasicMarkdownFallback(cleanText);
    }

    function normalizeMalformedMarkdownLinks(text) {
        return String(text || '').replace(/\[([^\]]+)\]\s+\((https?:\/\/[^\s)]+)\)/g, '[$1]($2)');
    }

    function sanitizeHtml(rawText) {
        try {
            const customerText = sanitizeCustomerResponseText(rawText);
            const normalizedText = normalizeMalformedMarkdownLinks(customerText);
            let html = renderMarkdownWithParser(normalizedText);
            const purify = getDomPurify();
            if (purify && typeof purify.sanitize === 'function') {
                try {
                    html = purify.sanitize(html, {
                        ADD_ATTR: ['data-code-copy', 'data-code-language']
                    });
                } catch (e) { }
            }
            return enhanceMarkdownCodeBlocks(enhanceMarkdownLinks(enhanceBareTextLinks(html)));
        } catch (error) {
            console.error('[AFD-AI-CHAT] sanitizeHtml error:', error);
            return parseBasicMarkdownFallback(rawText);
        }
    }

    function sanitizeStreamingHtml(rawText) {
        // Streaming is intentionally rendered with the dependency-free
        // fallback. Re-running Marked, DOMPurify, link enhancement and syntax
        // highlighting over the complete response for every small chunk makes
        // the bubble repaint and reflow increasingly expensive as the answer
        // grows. The source is escaped before the fallback adds its small,
        // allow-listed Markdown subset; the completed response still goes
        // through the full sanitizer in `sanitizeHtml`.
        try {
            const customerText = sanitizeCustomerResponseText(rawText);
            const stableText = normalizeMalformedMarkdownLinks(stabilizeStreamingMarkdown(customerText));
            // `parseBasicMarkdownFallback` already handles complete HTTPS
            // Markdown links. Defer DOM-based bare-link enhancement until the
            // final render; constructing a temporary container and walking it
            // on every animation frame was a measurable source of jank for
            // long answers.
            return parseBasicMarkdownFallback(stableText);
        } catch (error) {
            console.error('[AFD-AI-CHAT] sanitizeStreamingHtml error:', error);
            return parseBasicMarkdownFallback(sanitizeCustomerResponseText(rawText));
        }
    }

    // Codex-style block streaming: markdown before the first incomplete
    // entity is stable, so blocks can be rendered independently. Splitting
    // must respect markdown structure, though — a blank line inside a ```
    // fence or between loose list items does not start a new block.
    function splitStreamingBlocks(text) {
        const segments = normalizeMarkdownWhitespace(text)
            .split(/\n{2,}/)
            .map(segment => segment.trim())
            .filter(segment => segment.length > 0);

        // Fold fence-internal blank lines back into one segment.
        const fenceAware = [];
        let inFence = false;
        let fenceBuffer = [];
        segments.forEach((segment) => {
            const fenceMarkers = (segment.match(/^```/gm) || []).length;
            if (inFence) {
                fenceBuffer.push(segment);
                if (fenceMarkers % 2 === 1) {
                    inFence = false;
                    fenceAware.push(fenceBuffer.join('\n\n'));
                    fenceBuffer = [];
                }
                return;
            }
            if (fenceMarkers % 2 === 1) {
                inFence = true;
                fenceBuffer = [segment];
                return;
            }
            fenceAware.push(segment);
        });
        if (fenceBuffer.length > 0) {
            fenceAware.push(fenceBuffer.join('\n\n'));
        }

        // A loose list ("1. a\n\n2. b") is one list in the final render;
        // splitting it would restart numbering and re-style each item.
        const listMarker = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
        const merged = [];
        fenceAware.forEach((segment) => {
            const previous = merged[merged.length - 1];
            if (previous !== undefined && listMarker.test(segment) && listMarker.test(previous)) {
                merged[merged.length - 1] = previous + '\n\n' + segment;
                return;
            }
            merged.push(segment);
        });
        return merged;
    }

    // Streaming blocks are parsed with the real Markdown parser — the way
    // Codex streams — so headings, lists and fences are styled while the
    // answer is still arriving, not only after `done`. Stable blocks hit
    // the cache, so each frame only re-parses the growing last block.
    const streamingBlockCache = new Map();

    function renderStreamingBlockHtml(rawBlock) {
        const source = String(rawBlock || '');
        const cached = streamingBlockCache.get(source);
        if (cached !== undefined) return cached;

        let html;
        try {
            const customerText = sanitizeCustomerResponseText(source);
            html = renderMarkdownWithParser(normalizeMarkdownWhitespace(customerText));
            const purify = getDomPurify();
            if (purify && typeof purify.sanitize === 'function') {
                html = purify.sanitize(html, {
                    ADD_ATTR: ['data-code-copy', 'data-code-language']
                });
            }
            // Match the final render's outerHTML byte-for-byte so the
            // streaming→done diff keeps unchanged blocks' DOM untouched.
            html = String(html || '').trim();
        } catch (error) {
            html = parseBasicMarkdownFallback(source);
        }

        if (streamingBlockCache.size > 300) {
            streamingBlockCache.clear();
        }
        streamingBlockCache.set(source, html);
        return html;
    }

    function sanitizeStreamingHtmlBlocks(rawText) {
        try {
            const customerText = sanitizeCustomerResponseText(rawText);
            const stableText = normalizeMalformedMarkdownLinks(stabilizeStreamingMarkdown(customerText));
            return splitStreamingBlocks(stableText)
                .map(block => renderStreamingBlockHtml(block))
                .filter(blockHtml => String(blockHtml || '').trim().length > 0);
        } catch (error) {
            console.error('[AFD-AI-CHAT] sanitizeStreamingHtmlBlocks error:', error);
            return [parseBasicMarkdownFallback(sanitizeCustomerResponseText(rawText))];
        }
    }

    // Split fully sanitized HTML into top-level block HTML strings so the
    // final render can be diffed against the streamed blocks: paragraphs
    // whose HTML did not change keep their DOM node and never re-animate.
    function splitHtmlBlocks(htmlText) {
        const source = String(htmlText || '');
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
            return source ? [source] : [];
        }
        const container = document.createElement('div');
        container.innerHTML = source;
        const children = Array.from(container.childNodes);
        // The dependency-free fallback (no Marked available yet) produces
        // inline runs — top-level text with <strong>/<br> mixed in. Those
        // must stay one block, otherwise a single paragraph scatters into
        // fragment "blocks" that each fade in separately.
        const hasTopLevelText = children.some(node => (
            node.nodeType === Node.TEXT_NODE
            && String(node.textContent || '').trim().length > 0
        ));
        if (hasTopLevelText) {
            return source.trim() ? [source] : [];
        }
        return children
            .filter(node => node.nodeType === Node.ELEMENT_NODE)
            .map(node => node.outerHTML);
    }
    function sanitizeCustomerResponseText(value) {
        return String(value || '')
            .replace(/\b(?:searchWeb|searchStoreKnowledge|getProductAvailability|compareProducts|searchProducts|listCategories|updateCartItem|removeFromCart|getCustomerInfo|getRecentOrders|getGuestOrders|getGuestOrderDetails|getOrderDetails|getOrderFulfillment|cancelOrder|requestReturn|handoffToHuman|subscribeBackInStock|updateGuestOrderAddress|updateOrderAddress|getCustomerAddresses|updateCustomerAddress|getActiveCoupons|addToCart|CATALOG_CONTEXT)\b/gi, '')
            .replace(/\bwith (?:categoryId|category_id)\s*\d+/gi, '')
            .replace(/\b(?:categoryId|category_id|storeCode|customer_id|customerToken|website_id|store_id)\s*[:=]?\s*\d*\b/gi, '')
            // The legacy message table may be utf8mb3. Keep model prose
            // ASCII-safe and clean malformed replacement marks already stored
            // immediately before a Markdown link; UI Material Symbols remain
            // available through their dedicated HTML elements.
            .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
            .replace(/\?{2,}(?=\s*(?:\[[^\]\n]+\]\(|https?:\/\/))/gu, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+([,.;:!?])/g, '$1');
    }
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value || '');
        return div.innerHTML;
    }
    function getBrowserFormKey() {
        return getCookieValue('form_key') || window.FORM_KEY || '';
    }
    function encodeMagentoUenc(url) {
        try {
            const source = String(url || '');
            const encoded = btoa(unescape(encodeURIComponent(source)));
            return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '~');
        } catch (e) {
            return '';
        }
    }
    function hydrateProductGridHtml(html) {
        const formKey = getBrowserFormKey();
        const currentUenc = encodeMagentoUenc(window.location.href || '');
        return String(html || '')
            .replace(/__AFD_FORM_KEY__/g, formKey)
            .replace(/__AFD_UENC__/g, currentUenc);
    }
    function getCookieValue(name) {
        try {
            const cookies = document.cookie.split(';');
            for (const item of cookies) {
                const [key, value] = item.trim().split('=');
                if (key === name) {
                    return decodeURIComponent(value || '');
                }
            }
        } catch (e) { }
        return '';
    }
    function resolveWebSocketUrl(rawUrl) {
        const pageFallback = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ai-gateway/`;
        const normalizedRaw = String(rawUrl || pageFallback).replace(/^http/i, 'ws');
        let parsed;
        try {
            parsed = new URL(normalizedRaw);
        } catch (e) {
            parsed = new URL(pageFallback);
        }

        const pageHost = window.location.hostname;
        const localHosts = ['localhost', '127.0.0.1', '::1'];

        // A secure storefront cannot connect to a plain ws:// gateway.
        // Local reverse proxies (including the development tunnel) expose
        // the gateway on the storefront origin at /ai-gateway/.
        if (window.location.protocol === 'https:' && parsed.protocol === 'ws:') {
            return `wss://${window.location.host}/ai-gateway/`;
        }

        if (pageHost && !localHosts.includes(pageHost) && localHosts.includes(parsed.hostname)) {
            parsed.hostname = pageHost;
        }

        return parsed.toString().replace(/\?$/, '');
    }
    const PET_SPRITESHEET_COLUMNS = 8;
    const PET_SPRITESHEET_ROWS = 9;
    const PET_IDLE_BASE_FRAMES = [
        { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
        { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
        { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
        { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
        { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
        { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 }
    ];
    function buildPetFrames(rowIndex, length, frameDurationMs, lastFrameDurationMs) {
        return Array.from({ length }, (_, index) => ({
            rowIndex,
            columnIndex: index,
            frameDurationMs: index === length - 1 ? lastFrameDurationMs : frameDurationMs
        }));
    }
    function clonePetFrames(frames, multiplier) {
        return frames.map(frame => ({
            ...frame,
            frameDurationMs: frame.frameDurationMs * multiplier
        }));
    }
    const PET_FRAME_LIBRARY = {
        failed: buildPetFrames(5, 8, 140, 240),
        idle: clonePetFrames(PET_IDLE_BASE_FRAMES, 6),
        jumping: buildPetFrames(4, 5, 140, 280),
        review: buildPetFrames(8, 6, 150, 280),
        running: buildPetFrames(7, 6, 120, 220),
        'running-left': buildPetFrames(2, 8, 120, 220),
        'running-right': buildPetFrames(1, 8, 120, 220),
        waving: buildPetFrames(3, 4, 140, 280),
        waiting: buildPetFrames(6, 6, 150, 260)
    };
    function petFramePosition(frame) {
        return `${frame.columnIndex / (PET_SPRITESHEET_COLUMNS - 1) * 100}% ${frame.rowIndex / (PET_SPRITESHEET_ROWS - 1) * 100}%`;
    }
    const attachmentLimits = window.afdAiChatConfig?.attachmentLimits || {};
    const IMAGE_UPLOAD_MAX_BYTES = Math.max(256 * 1024, Number(attachmentLimits.maxImageBytes) || 4 * 1024 * 1024);
    const IMAGE_UPLOAD_MAX_COUNT = Math.max(1, Math.min(4, Number(attachmentLimits.maxImages) || 4));
    const IMAGE_UPLOAD_MAX_TOTAL_BYTES = Math.max(256 * 1024, Number(attachmentLimits.maxTotalImageBytes) || 6 * 1024 * 1024);
    const MAX_WEBSOCKET_PAYLOAD_BYTES = Math.max(1 * 1024 * 1024, Number(attachmentLimits.maxWebSocketPayloadBytes) || 8 * 1024 * 1024);
    const MAX_WEBSOCKET_IMAGE_RESERVE_BYTES = 2 * 1024 * 1024;
    const MAX_WEBSOCKET_ENCODED_IMAGE_BYTES = Math.max(
        512 * 1024,
        MAX_WEBSOCKET_PAYLOAD_BYTES - MAX_WEBSOCKET_IMAGE_RESERVE_BYTES
    );
    const IMAGE_UPLOAD_MAX_ENCODED_BYTES = Math.min(
        Math.max(512 * 1024, Number(attachmentLimits.maxTotalEncodedBytes) || 6 * 1024 * 1024),
        MAX_WEBSOCKET_ENCODED_IMAGE_BYTES
    );
    const IMAGE_UPLOAD_MAX_TOTAL_PIXELS = Math.max(1_000_000, Number(attachmentLimits.maxTotalPixels) || 30_000_000);
    const IMAGE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    // Transport enough recent messages for the gateway to apply the
    // Magento-synced message and token budgets. The browser no longer
    // silently overrides an Admin value above sixteen.
    const MAX_MODEL_HISTORY_MESSAGES = 40;

    function utf8ByteLength(value) {
        const source = String(value || '');
        if (typeof TextEncoder === 'function') {
            return new TextEncoder().encode(source).byteLength;
        }
        return unescape(encodeURIComponent(source)).length;
    }

    function mergeProductGridHtml(existingHtml, nextHtml) {
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
    }

    function mergeProductPayload(existingPayload, incomingPayload) {
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
    }

    function postFeedback(url, payload) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = window.setTimeout(() => controller?.abort(), 10000);

        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-Form-Key': getBrowserFormKey()
            },
            body: JSON.stringify(payload),
            ...(controller ? { signal: controller.signal } : {})
        })
        .then(async (response) => {
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
        })
        .catch((error) => {
            if (controller?.signal.aborted) {
                throw new Error('The feedback request timed out. Please try again.');
            }
            throw error;
        })
        .finally(() => {
            window.clearTimeout(timeoutId);
        });
    }

    // Storefront debug tracing. Off unless the merchant opts in via
    // window.afdAiChatConfig.debug, so production consoles stay quiet.
    function debugLog(...args) {
        try {
            if (typeof window === 'undefined' || window.afdAiChatConfig?.debug !== true) return;
            if (typeof console === 'undefined' || typeof console.log !== 'function') return;
            console.log(...args);
        } catch (e) { }
    }

    modules.helpers = {
        sanitizeHtml,
        sanitizeStreamingHtml,
        sanitizeStreamingHtmlBlocks,
        splitHtmlBlocks,
        normalizeMarkdownForCopy,
        sanitizeCustomerResponseText,
        escapeHtml,
        stabilizeStreamingMarkdown,
        hydrateProductGridHtml,
        getBrowserFormKey,
        resolveWebSocketUrl,
        PET_SPRITESHEET_COLUMNS,
        PET_SPRITESHEET_ROWS,
        PET_FRAME_LIBRARY,
        petFramePosition,
        IMAGE_UPLOAD_MAX_BYTES,
        IMAGE_UPLOAD_MAX_COUNT,
        IMAGE_UPLOAD_MAX_TOTAL_BYTES,
        IMAGE_UPLOAD_MAX_ENCODED_BYTES,
        IMAGE_UPLOAD_MAX_TOTAL_PIXELS,
        MAX_WEBSOCKET_PAYLOAD_BYTES,
        IMAGE_UPLOAD_TYPES,
        MAX_MODEL_HISTORY_MESSAGES,
        utf8ByteLength,
        mergeProductGridHtml,
        mergeProductPayload,
        postFeedback,
        debugLog
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
