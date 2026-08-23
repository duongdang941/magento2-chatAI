import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/shell.js', import.meta.url),
    'utf8'
);
const conversationTemplate = fs.readFileSync(
    new URL('../../view/frontend/templates/chat/partials/conversation.phtml', import.meta.url),
    'utf8'
);

function createShellMethods({ documentImpl, browserWindow, ResizeObserverImpl } = {}) {
    const browser = {
        AfdAiChat: {},
        ...browserWindow
    };
    vm.runInNewContext(source, {
        window: browser,
        document: documentImpl,
        ResizeObserver: ResizeObserverImpl,
        String,
        Number,
        Math,
        Date,
        RegExp,
        Object,
        Array,
        Set,
        Map,
        JSON,
        console
    });
    return browser.AfdAiChat.shellMethods({
        config: {},
        urls: {},
        helpers: {}
    });
}

function flushFrames(frames) {
    while (frames.length > 0) {
        frames.shift()();
    }
}

function createChatWindow() {
    const content = {};
    const anchorSpacer = { offsetHeight: 0, getBoundingClientRect() { return { height: this.offsetHeight }; } };
    const listeners = new Map();
    return {
        content,
        anchorSpacer,
        listeners,
        scrollHeight: 500,
        clientHeight: 200,
        scrollTop: 0,
        scrollLeft: 12,
        querySelector(selector) {
            if (selector === '[data-role="chat-scroll-content"]') return content;
            if (selector === '[data-role="chat-turn-anchor-spacer"]') return anchorSpacer;
            return null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) listeners.delete(type);
        }
    };
}

test('wraps the message flow in a resize-observable content element', () => {
    assert.match(conversationTemplate, /data-role="chat-scroll-content"/);
    assert.match(conversationTemplate, /x-init="observeMessageScrollContent\(\$el\)"/);
    assert.match(conversationTemplate, /x-show="isTurnStartPinned && pinnedTurnRequestId"/);
    assert.doesNotMatch(conversationTemplate, /x-show="isLoading && isTurnStartPinned/);
});

test('follows streaming content after its rendered height grows', () => {
    const frames = [];
    const observers = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            observers.push(this);
        }

        observe(element) {
            this.observed.push(element);
        }

        disconnect() {}
    }

    const chatWindow = createChatWindow();
    const methods = createShellMethods({
        documentImpl: { getElementById: id => id === 'chatWindow' ? chatWindow : null },
        browserWindow: {
            requestAnimationFrame(callback) {
                frames.push(callback);
                return frames.length;
            },
            cancelAnimationFrame() {}
        },
        ResizeObserverImpl: FakeResizeObserver
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        $nextTick(callback) { callback(); },
        observeMessageScrollContent: methods.observeMessageScrollContent,
        scrollToBottom: methods.scrollToBottom
    };

    component.scrollToBottom.call(component);
    flushFrames(frames);

    assert.equal(chatWindow.scrollTop, 300);
    assert.equal(chatWindow.scrollLeft, 0);
    assert.deepEqual(observers[0].observed, [chatWindow, chatWindow.content]);

    // This simulates a Markdown block or image changing layout after the
    // streaming state was already flushed. No second provider delta arrives.
    chatWindow.scrollHeight = 660;
    observers[0].callback([{ target: chatWindow.content }]);
    flushFrames(frames);

    assert.equal(chatWindow.scrollTop, 460);
    assert.equal(component.isAtChatBottom, true);
    assert.equal(component.hasUnreadMessages, false);
});

test('does not pull a reader back down after they scroll away from the latest output', () => {
    const frames = [];
    const observers = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }

        observe() {}
        disconnect() {}
    }

    const chatWindow = createChatWindow();
    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {
            requestAnimationFrame(callback) {
                frames.push(callback);
                return frames.length;
            },
            cancelAnimationFrame() {}
        },
        ResizeObserverImpl: FakeResizeObserver
    });
    const component = {
        isAtChatBottom: false,
        hasUnreadMessages: false,
        $nextTick(callback) { callback(); },
        observeMessageScrollContent: methods.observeMessageScrollContent,
        scrollToBottom: methods.scrollToBottom
    };

    component.observeMessageScrollContent.call(component, chatWindow);
    chatWindow.scrollTop = 85;
    chatWindow.scrollHeight = 700;
    observers[0].callback([{ target: chatWindow.content }]);
    flushFrames(frames);

    assert.equal(chatWindow.scrollTop, 85);
    assert.equal(component.hasUnreadMessages, true);

    component.scrollToBottom.call(component, true);
    flushFrames(frames);
    assert.equal(chatWindow.scrollTop, 500);
    assert.equal(component.isAtChatBottom, true);
    assert.equal(component.hasUnreadMessages, false);
});

test('does not treat a layout-generated scroll event as a reader scrolling away', () => {
    const chatWindow = createChatWindow();
    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {
            requestAnimationFrame(callback) { callback(); return 1; },
            cancelAnimationFrame() {}
        },
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        observeMessageScrollContent: methods.observeMessageScrollContent,
        handleMessageScroll: methods.handleMessageScroll
    };

    component.observeMessageScrollContent.call(component, chatWindow);
    chatWindow.scrollTop = 70;
    chatWindow.scrollHeight = 700;
    component.handleMessageScroll.call(component, { currentTarget: chatWindow });

    assert.equal(component.isAtChatBottom, true);
    assert.equal(component.hasUnreadMessages, false);

    chatWindow.listeners.get('wheel')();
    component.handleMessageScroll.call(component, { currentTarget: chatWindow });
    assert.equal(component.isAtChatBottom, false);
});

test('keeps a short active turn anchored when the reader uses the mouse wheel', () => {
    const chatWindow = createChatWindow();
    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {
            requestAnimationFrame(callback) { callback(); return 1; },
            cancelAnimationFrame() {}
        },
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        isTurnStartPinned: true,
        pinnedTurnRequestId: 'new-turn',
        observeMessageScrollContent: methods.observeMessageScrollContent,
        handleMessageScroll: methods.handleMessageScroll
    };

    component.observeMessageScrollContent.call(component, chatWindow);
    chatWindow.listeners.get('wheel')({ type: 'wheel' });
    chatWindow.scrollTop = 70;
    chatWindow.scrollHeight = 700;
    component.handleMessageScroll.call(component, { currentTarget: chatWindow });

    assert.equal(component.isAtChatBottom, true);
    assert.equal(component.isTurnStartPinned, true);
    assert.equal(component.pinnedTurnRequestId, 'new-turn');
});

test('keeps the existing reply branch visible while an older user message is edited', () => {
    const methods = createShellMethods({ browserWindow: {} });
    const component = {
        editingMessageIndex: 2,
        humanSupportActive: false,
        shouldShowMessage: methods.shouldShowMessage
    };
    const laterAssistantReply = {
        role: 'assistant',
        parts: [{ type: 'text', raw: 'The existing reply remains readable.' }]
    };

    assert.equal(component.shouldShowMessage.call(component, laterAssistantReply, 3), true);
});

test('pins a newly submitted user turn at the top until that turn fills the viewport', () => {
    const chatWindow = createChatWindow();
    const userMessage = {
        dataset: { requestId: 'new-turn' },
        getBoundingClientRect() { return { top: 104 - (chatWindow.scrollTop - 500) }; }
    };
    chatWindow.scrollTop = 500;
    chatWindow.scrollHeight = 850;
    chatWindow.clientHeight = 300;
    chatWindow.getBoundingClientRect = () => ({ top: 0 });
    chatWindow.querySelectorAll = selector => selector === '[data-role="chat-user-message"]' ? [userMessage] : [];

    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        isTurnStartPinned: false,
        pinnedTurnRequestId: '',
        currentTurnUserMessage: methods.currentTurnUserMessage,
        pinCurrentTurnToTop: methods.pinCurrentTurnToTop,
        shouldKeepCurrentTurnAtTop: methods.shouldKeepCurrentTurnAtTop
    };

    component.pinCurrentTurnToTop.call(component, 'new-turn');

    assert.equal(chatWindow.scrollTop, 496);
    assert.equal(component.isTurnStartPinned, true);
    assert.equal(component.shouldKeepCurrentTurnAtTop.call(component, chatWindow), true);

    chatWindow.scrollHeight = 980;
    assert.equal(component.shouldKeepCurrentTurnAtTop.call(component, chatWindow), false);
    assert.equal(component.isTurnStartPinned, false);
});

test('excludes the temporary Codex-style spacer when measuring active-turn height', () => {
    const chatWindow = createChatWindow();
    chatWindow.scrollTop = 496;
    chatWindow.scrollHeight = 1060;
    chatWindow.clientHeight = 300;
    chatWindow.anchorSpacer.offsetHeight = 210;
    const userMessage = {
        dataset: { requestId: 'new-turn' },
        getBoundingClientRect() { return { top: 108 }; }
    };
    chatWindow.getBoundingClientRect = () => ({ top: 0 });
    chatWindow.querySelectorAll = () => [userMessage];

    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isTurnStartPinned: true,
        pinnedTurnRequestId: 'new-turn',
        currentTurnUserMessage: methods.currentTurnUserMessage,
        shouldKeepCurrentTurnAtTop: methods.shouldKeepCurrentTurnAtTop
    };

    assert.equal(component.shouldKeepCurrentTurnAtTop.call(component, chatWindow), true);
    assert.equal(component.isTurnStartPinned, true);
});

test('keeps a short completed turn pinned after done removes the loading state', () => {
    const chatWindow = createChatWindow();
    chatWindow.scrollTop = 496;
    chatWindow.scrollHeight = 1060;
    chatWindow.clientHeight = 300;
    chatWindow.anchorSpacer.offsetHeight = 210;
    const userMessage = {
        dataset: { requestId: 'new-turn' },
        getBoundingClientRect() { return { top: 108 }; }
    };
    chatWindow.getBoundingClientRect = () => ({ top: 0 });
    chatWindow.querySelectorAll = () => [userMessage];

    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        isLoading: false,
        activeRequestId: null,
        isTurnStartPinned: true,
        pinnedTurnRequestId: 'new-turn',
        $nextTick(callback) { callback(); },
        currentTurnUserMessage: methods.currentTurnUserMessage,
        shouldKeepCurrentTurnAtTop: methods.shouldKeepCurrentTurnAtTop,
        observeMessageScrollContent: methods.observeMessageScrollContent,
        scrollToBottom: methods.scrollToBottom
    };

    component.scrollToBottom.call(component);

    assert.equal(chatWindow.scrollTop, 496);
    assert.equal(component.isTurnStartPinned, true);
    assert.equal(component.pinnedTurnRequestId, 'new-turn');
});

test('moves a completed short turn back to the reading position once its spacer is rendered', () => {
    const chatWindow = createChatWindow();
    chatWindow.scrollTop = 500;
    chatWindow.scrollHeight = 1030;
    chatWindow.clientHeight = 300;
    chatWindow.anchorSpacer.offsetHeight = 210;
    const userMessage = {
        dataset: { requestId: 'new-turn' },
        getBoundingClientRect() { return { top: 720 - chatWindow.scrollTop }; }
    };
    chatWindow.getBoundingClientRect = () => ({ top: 0 });
    chatWindow.querySelectorAll = () => [userMessage];

    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isAtChatBottom: true,
        hasUnreadMessages: false,
        isLoading: false,
        activeRequestId: null,
        isTurnStartPinned: true,
        pinnedTurnRequestId: 'new-turn',
        $nextTick(callback) { callback(); },
        currentTurnUserMessage: methods.currentTurnUserMessage,
        shouldKeepCurrentTurnAtTop: methods.shouldKeepCurrentTurnAtTop,
        pinCurrentTurnToTop: methods.pinCurrentTurnToTop,
        observeMessageScrollContent: methods.observeMessageScrollContent,
        scrollToBottom: methods.scrollToBottom
    };

    component.scrollToBottom.call(component);

    assert.equal(chatWindow.scrollTop, 612);
    assert.equal(720 - chatWindow.scrollTop, 108);
    assert.equal(component.isTurnStartPinned, true);
});

test('keeps the customer message as the reading anchor after the AI response is mounted', () => {
    const chatWindow = createChatWindow();
    chatWindow.scrollTop = 500;
    chatWindow.scrollHeight = 1120;
    chatWindow.clientHeight = 300;
    chatWindow.anchorSpacer.offsetHeight = 210;
    const userMessage = {
        dataset: { requestId: 'new-turn' },
        getBoundingClientRect() { return { top: 720 - chatWindow.scrollTop }; }
    };
    const hiddenAssistantMessage = {
        dataset: { requestId: '' },
        getBoundingClientRect() { return { top: -59, height: 0 }; }
    };
    const assistantMessage = {
        dataset: { requestId: '' },
        getBoundingClientRect() { return { top: 780 - chatWindow.scrollTop, height: 120 }; }
    };
    chatWindow.getBoundingClientRect = () => ({ top: 0 });
    chatWindow.querySelectorAll = selector => {
        if (selector === '[data-role="chat-assistant-message"]') return [hiddenAssistantMessage, assistantMessage];
        if (selector === '[data-role="chat-user-message"]') return [userMessage];
        return [];
    };

    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isTurnStartPinned: false,
        pinnedTurnRequestId: '',
        currentTurnUserMessage: methods.currentTurnUserMessage,
        currentTurnAnchorMessage: methods.currentTurnAnchorMessage,
        pinCurrentTurnToTop: methods.pinCurrentTurnToTop
    };

    component.pinCurrentTurnToTop.call(component, 'new-turn');

    assert.equal(chatWindow.scrollTop, 612);
    assert.equal(720 - chatWindow.scrollTop, 108);
});

test('keeps the new-turn anchor through the Alpine render gap', () => {
    const chatWindow = createChatWindow();
    const methods = createShellMethods({
        documentImpl: { getElementById: () => chatWindow },
        browserWindow: {},
        ResizeObserverImpl: class {
            observe() {}
            disconnect() {}
        }
    });
    const component = {
        isLoading: true,
        activeRequestId: 'new-turn',
        isTurnStartPinned: true,
        pinnedTurnRequestId: 'new-turn',
        currentTurnUserMessage: methods.currentTurnUserMessage,
        shouldKeepCurrentTurnAtTop: methods.shouldKeepCurrentTurnAtTop
    };

    assert.equal(component.shouldKeepCurrentTurnAtTop.call(component, chatWindow), true);
    assert.equal(component.isTurnStartPinned, true);

    component.activeRequestId = '';
    component.isLoading = false;
    assert.equal(component.shouldKeepCurrentTurnAtTop.call(component, chatWindow), false);
    assert.equal(component.isTurnStartPinned, false);
});
