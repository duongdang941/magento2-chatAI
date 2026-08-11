import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/stream-renderer.js', import.meta.url),
    'utf8'
);

function createRendererMethods() {
    const browserWindow = { AfdAiChat: {}, AfdStreamingMarkdown: null };
    vm.runInNewContext(source, {
        window: browserWindow,
        HTMLElement: class {},
        HTMLImageElement: class {},
        String,
        Date,
        Math,
        Map
    });

    return browserWindow.AfdAiChat.streamRendererMethods({
        helpers: {
            sanitizeHtml: value => `final:${value}`,
            sanitizeStreamingHtml: value => `stream:${value}`
        }
    });
}

test('keeps raw streamed text append-only until one final markdown pass', () => {
    const methods = createRendererMethods();
    const part = methods.createStreamingTextPart('Hello');

    methods.appendStreamingText.call(methods, part, ' world');
    assert.equal(part.raw, 'Hello world');
    assert.equal(part.html, '');
    assert.equal(part.streaming, true);

    methods.finalizeStreamingText.call(methods, part);
    assert.equal(part.html, 'final:Hello world');
    assert.equal(part.streaming, false);
});
