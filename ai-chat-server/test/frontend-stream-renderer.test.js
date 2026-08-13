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
