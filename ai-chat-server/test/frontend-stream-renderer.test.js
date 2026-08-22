import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream-renderer.js', import.meta.url),
    'utf8'
);
const conversationTemplate = fs.readFileSync(
    new URL('../../view/frontend/templates/chat/partials/conversation.phtml', import.meta.url),
    'utf8'
);

function createRendererMethods({ browserWindow: windowOverrides = {}, DateImpl = Date, documentImpl = {} } = {}) {
    const browserWindow = {
        AfdAiChat: {},
        AfdStreamingMarkdown: null,
        ...windowOverrides
    };
    vm.runInNewContext(source, {
        window: browserWindow,
        HTMLElement: class {},
        HTMLImageElement: class {},
        String,
        Date: DateImpl,
        Math,
        Map,
        document: documentImpl
    });

    return browserWindow.AfdAiChat.streamRendererMethods({
        helpers: {
            sanitizeHtml: value => `final:${value}`,
            sanitizeStreamingHtml: value => `stream:${value}`,
            sanitizeStreamingHtmlBlocks: value => [`stream:${value}`],
            splitHtmlBlocks: value => value ? [value] : []
        }
    });
}

function createFakeElement(tagName = 'div') {
    const classes = new Set();
    const element = {
        tagName: String(tagName).toUpperCase(),
        children: [],
        dataset: {},
        style: { setProperty() {} },
        classList: {
            add(name) { classes.add(name); },
            contains(name) { return classes.has(name); }
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        replaceChild(child, current) {
            const index = this.children.indexOf(current);
            if (index >= 0) this.children[index] = child;
            return current;
        },
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
            return child;
        }
    };

    Object.defineProperties(element, {
        childNodes: { get: () => element.children },
        firstChild: { get: () => element.children[0] || null },
        lastElementChild: { get: () => element.children[element.children.length - 1] || null },
        innerHTML: {
            get: () => element._innerHTML || '',
            set: (html) => {
                element._innerHTML = String(html || '');
                element.children = element._innerHTML ? [createFakeElement('span')] : [];
            }
        }
    });
    return element;
}

test('waits for the Markdown render frame before scheduling streaming scroll', () => {
    const frames = [];
    let now = 0;
    const methods = createRendererMethods({
        browserWindow: {
            requestAnimationFrame(callback) {
                frames.push(callback);
                return frames.length;
            }
        },
        DateImpl: {
            now() {
                now += 40;
                return now;
            }
        }
    });
    let scrollCount = 0;
    methods.scheduleStreamingScroll = () => {
        scrollCount += 1;
    };

    const part = methods.createStreamingTextPart('Hello');
    assert.equal(scrollCount, 0);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(scrollCount, 1);

    methods.appendStreamingText(part, ' world');
    assert.equal(part.raw, 'Hello world');
    assert.equal(scrollCount, 1);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(part.html, 'stream:Hello world');
    assert.equal(scrollCount, 2);
});

test('coalesces a provider burst into one frame and renders the latest text', () => {
    const frames = [];
    let renderCount = 0;
    const browserWindow = {
        AfdAiChat: {},
        requestAnimationFrame(callback) {
            frames.push(callback);
            return frames.length;
        }
    };
    vm.runInNewContext(source, {
        window: browserWindow,
        HTMLElement: class {},
        HTMLImageElement: class {},
        String,
        Date,
        Math,
        Map
    });
    const renderer = browserWindow.AfdAiChat.streamRendererMethods({
        helpers: {
            sanitizeHtml: value => `final:${value}`,
            sanitizeStreamingHtml: value => {
                renderCount += 1;
                return `stream:${value}`;
            },
            sanitizeStreamingHtmlBlocks: value => {
                renderCount += 1;
                return [`stream:${value}`];
            },
            splitHtmlBlocks: value => value ? [value] : []
        }
    });
    const part = renderer.createStreamingTextPart('A');
    renderer.appendStreamingText(part, ' quick');
    renderer.appendStreamingText(part, ' answer');

    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(renderCount, 1);
    assert.equal(part.html, 'stream:A quick answer');
});

test('delegates streaming scroll to the component next-tick implementation', () => {
    const methods = createRendererMethods();
    let scrollCount = 0;
    methods.scrollToBottom = () => {
        scrollCount += 1;
    };

    methods.scheduleStreamingScroll();
    assert.equal(scrollCount, 1);
});

test('renders streaming text through the Markdown renderer and finalizes it once complete', () => {
    const methods = createRendererMethods();
    const part = methods.createStreamingTextPart('Hello');

    methods.appendStreamingText.call(methods, part, ' world');
    assert.equal(part.raw, 'Hello world');
    assert.equal(part.html, 'stream:Hello world');
    assert.equal(part.streaming, true);
    assert.equal('mountStreamingMarkdown' in methods, false);

    methods.finalizeStreamingText.call(methods, part);
    assert.equal(part.html, 'final:Hello world');
    assert.equal(part.streaming, false);

    const spacedPart = methods.createStreamingTextPart('First paragraph\n \n\n\nSecond paragraph\n\n\n');
    methods.finalizeStreamingText.call(methods, spacedPart);
    assert.equal(spacedPart.raw, 'First paragraph\n \n\n\nSecond paragraph\n\n\n');
    assert.equal(spacedPart.html, 'final:First paragraph\n \n\n\nSecond paragraph\n\n\n');
});

test('does not fade the complete response when final markup replaces streaming blocks', () => {
    const fakeDocument = { createElement: tagName => createFakeElement(tagName) };
    const methods = createRendererMethods({ documentImpl: fakeDocument });
    const target = createFakeElement('div');

    methods.patchMessageHtml(target, ['<p>First block</p>'], false);
    assert.equal(target.children[0].classList.contains('afd-ai-chat__block-fade'), false);

    methods.patchMessageHtml(target, ['<p>First block</p>', '<p>Second block</p>'], true);
    assert.equal(target.children[0].classList.contains('afd-ai-chat__block-fade'), false);
    assert.equal(target.children[1].classList.contains('afd-ai-chat__block-fade'), true);
    assert.match(
        conversationTemplate,
        /patchMessageHtml\(\$el, part\.blocks \|\| part\.html, part\.streaming === true\)/
    );
});
