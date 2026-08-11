import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const streamSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream.js', import.meta.url),
    'utf8'
);
const sandbox = { window: { AfdAiChat: {} }, document: {} };
vm.runInNewContext(streamSource, sandbox);

const methods = sandbox.window.AfdAiChat.streamMethods({
    config: {},
    urls: {},
    helpers: {
        hydrateProductGridHtml: (html) => html
    }
});

test('editing a customer turn stops an active response before opening the editor', () => {
    let stopped = 0;
    const context = {
        isLoading: true,
        isReadingAttachments: false,
        messages: [{ role: 'user', content: 'Find a jacket', attachments: [], mutationBusy: false }],
        editingMessageIndex: null,
        editingMessageDraft: '',
        editingMessageAttachments: [],
        messageFeedback: {},
        copiedMessageIndex: null,
        stopCurrentResponse() {
            stopped += 1;
            this.isLoading = false;
        },
        copyMessageAttachments: () => [],
        resizeEditMessageInput: () => {},
        getEditMessageInput: () => null,
        $nextTick: (callback) => callback()
    };

    methods.editMessage.call(context, 0);

    assert.equal(stopped, 1);
    assert.equal(context.editingMessageIndex, 0);
    assert.equal(context.editingMessageDraft, 'Find a jacket');
});

test('attaches a product presentation immediately once customer-facing text exists', () => {
    const context = {
        activeRequestId: 'request-1',
        cancelledRequestIds: {},
        currentAiMessageIndex: 0,
        messages: [{ role: 'assistant', parts: [{ type: 'text', raw: 'Here are the matching products.' }] }],
        pendingProductParts: [],
        shouldIgnoreStreamMessage: () => false,
        armResponseWatchdog: () => {},
        flushPendingProductParts() {
            this.messages[this.currentAiMessageIndex].parts.push(...this.pendingProductParts);
            this.pendingProductParts = [];
        },
        scrollToBottom: () => {},
        $nextTick: (callback) => callback()
    };

    methods.handleStreamMessage.call(context, {
        type: 'products_html',
        request_id: 'request-1',
        html: '<div class="afd-ai-chat__product-grid"></div>',
        products: { items: [{ id: 1 }] }
    });

    assert.equal(context.pendingProductParts.length, 0);
    assert.equal(context.messages[0].parts.at(-1).type, 'products');
});
