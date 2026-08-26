import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const windowSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/window.js', import.meta.url),
    'utf8'
);
const responsiveSource = fs.readFileSync(
    new URL('../../view/frontend/web/css/source/chat-widget/_responsive.less', import.meta.url),
    'utf8'
);
const shellSource = fs.readFileSync(
    new URL('../../view/frontend/web/css/source/chat-widget/_shell.less', import.meta.url),
    'utf8'
);

function createWindowMethods({ innerWidth = 780, innerHeight = 900, coarsePointer = false } = {}) {
    const browserWindow = {
        AfdAiChat: {},
        innerWidth,
        innerHeight,
        matchMedia(query) {
            return { matches: query === '(pointer: coarse)' && coarsePointer };
        }
    };
    vm.runInNewContext(windowSource, { window: browserWindow, Math, Number, JSON, localStorage: {} });
    return browserWindow.AfdAiChat.windowMethods({ config: {}, urls: {}, helpers: {} });
}

test('keeps desktop catalogue content intact inside a narrow Chrome window', () => {
    const methods = createWindowMethods({ innerWidth: 780 });
    const component = {
        chatWindowWidth: 774,
        chatWindowLayout: null,
        getResponsiveWindowWidth: methods.getResponsiveWindowWidth,
        isCompactViewport: methods.isCompactViewport
    };

    assert.equal(methods.isCompactViewport.call(component), false);
    assert.equal(methods.isMobileLayout.call(component), true);
});

test('uses compact layout only after the measured popup reaches its own minimum desktop width', () => {
    const methods = createWindowMethods({ innerWidth: 1200 });
    const component = {
        chatWindowWidth: 700,
        chatWindowLayout: null,
        getResponsiveWindowWidth: methods.getResponsiveWindowWidth,
        isCompactViewport: methods.isCompactViewport
    };

    assert.equal(methods.isCompactViewport.call(component), true);
});

test('does not contain a viewport-wide desktop breakpoint for popup layout', () => {
    assert.doesNotMatch(responsiveSource, /@media\s*\(max-width:\s*860px\)/);
    const compactBlock = responsiveSource.match(/&--compact-sidebar[\s\S]*?&--mobile-layout/)?.[0] || '';
    assert.doesNotMatch(compactBlock, /\.afd-ai-chat__product-grid[\s\S]*?grid-template-columns:/);
});

test('restores a theme-aware backdrop outside the chat window', () => {
    assert.match(shellSource, /\.afd-ai-chat__backdrop[\s\S]*?background:\s*rgba\(15,\s*23,\s*42,\s*0\.22\)/);
    assert.match(shellSource, /\.afd-ai-chat\[data-ui-theme="light"\] \.afd-ai-chat__backdrop[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.42\)/);
    assert.match(shellSource, /\.afd-ai-chat__backdrop[\s\S]*?pointer-events:\s*none/);
});
