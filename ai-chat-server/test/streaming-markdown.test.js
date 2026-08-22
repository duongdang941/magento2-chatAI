import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const helperSource = fs.readFileSync(
    path.resolve(testDirectory, '../../view/frontend/web/js/chat/helpers.js'),
    'utf8'
);
const sandbox = {
    URL,
    window: {
        AfdAiChat: {},
        location: {
            protocol: 'http:',
            hostname: 'afd.test',
            host: 'afd.test'
        }
    }
};
vm.runInNewContext(helperSource, sandbox);
const {
    normalizeMarkdownForCopy,
    resolveWebSocketUrl,
    stabilizeStreamingMarkdown
} = sandbox.window.AfdAiChat.helpers;

test('routes an insecure local gateway through the secure storefront proxy', () => {
    sandbox.window.location = {
        protocol: 'https:',
        hostname: 'shop-tunnel.example',
        host: 'shop-tunnel.example'
    };

    assert.equal(
        resolveWebSocketUrl('ws://shop-tunnel.example:3001'),
        'wss://shop-tunnel.example/ai-gateway/'
    );
});

test('preserves a direct local WebSocket gateway on an HTTP storefront', () => {
    sandbox.window.location = {
        protocol: 'http:',
        hostname: 'afd.test',
        host: 'afd.test'
    };

    assert.equal(resolveWebSocketUrl('ws://afd.test:3001'), 'ws://afd.test:3001/');
});

test('withholds an unfinished Markdown link from the live stream', () => {
    const source = 'Mở sản phẩm: [Bóng bay (Luftballons)](http://afd.test/bong-bay';
    assert.equal(stabilizeStreamingMarkdown(source), 'Mở sản phẩm: ');
});

test('buffers a Markdown link from its opening bracket until it is complete', () => {
    assert.equal(stabilizeStreamingMarkdown('Mở sản phẩm: [Bóng bay'), 'Mở sản phẩm: ');
    assert.equal(stabilizeStreamingMarkdown('Mở sản phẩm: [Bóng bay]'), 'Mở sản phẩm: ');
    assert.equal(stabilizeStreamingMarkdown('Mở sản phẩm: [Bóng bay]('), 'Mở sản phẩm: ');
});

test('renders a completed Markdown link without changing its text', () => {
    const source = 'Mở sản phẩm: [Bóng bay (Luftballons)](http://afd.test/bong-bay)';
    assert.equal(stabilizeStreamingMarkdown(source), source);
});

test('buffers an incomplete Markdown image as one inline entity', () => {
    assert.equal(stabilizeStreamingMarkdown('Hình: ![Áo khoác](https://afd.test/ao'), 'Hình: ');
    assert.equal(
        stabilizeStreamingMarkdown('Hình: ![Áo khoác](https://afd.test/ao-khoac.png)'),
        'Hình: ![Áo khoác](https://afd.test/ao-khoac.png)'
    );
});

test('renders a completed angle-bracket link without changing its text', () => {
    const source = 'Mở <https://afd.test/bong-bay>';
    assert.equal(stabilizeStreamingMarkdown(source), source);
});

test('withholds a bare URL until the streamed token has a stable boundary', () => {
    assert.equal(
        stabilizeStreamingMarkdown('Xem thêm tại https://afd.test/bong-bay'),
        'Xem thêm tại '
    );
});

test('streams words progressively without withholding partial trailing words', () => {
    assert.equal(
        stabilizeStreamingMarkdown('Một câu đang stream dở chữ'),
        'Một câu đang stream dở chữ'
    );
    assert.equal(
        stabilizeStreamingMarkdown('Một câu đã đủ chữ '),
        'Một câu đã đủ chữ '
    );
    assert.equal(
        stabilizeStreamingMarkdown('Một câu đã kết thúc.'),
        'Một câu đã kết thúc.'
    );
});

test('does not hide scripts that stream without inter-word whitespace', () => {
    assert.equal(stabilizeStreamingMarkdown('犬の世話'), '犬の世話');
});

test('withholds incomplete emphasis and code delimiters from the live stream', () => {
    assert.equal(stabilizeStreamingMarkdown('Đây là **một tiêu đề'), 'Đây là ');
    assert.equal(stabilizeStreamingMarkdown('Đây là **một tiêu đề**'), 'Đây là **một tiêu đề**');
    assert.equal(stabilizeStreamingMarkdown('Mã: `SKU-01'), 'Mã: ');
    assert.equal(stabilizeStreamingMarkdown('Mã: `SKU-01`'), 'Mã: `SKU-01`');
    assert.equal(stabilizeStreamingMarkdown('```js\nconst sku = "SKU-01";'), '');
    assert.equal(stabilizeStreamingMarkdown('```js\nconst sku = "SKU-01";\n```'), '```js\nconst sku = "SKU-01";\n```');
    assert.equal(stabilizeStreamingMarkdown('* Một lựa chọn'), '* Một lựa chọn');
    assert.equal(stabilizeStreamingMarkdown('snake_case'), 'snake_case');
});

test('normalizes copied Markdown to the visible response text', () => {
    assert.equal(
        normalizeMarkdownForCopy('Xem [chi tiết](https://afd.test/item).\n\n`SKU-01`'),
        'Xem chi tiết.\n\nSKU-01'
    );
});

test('normalizes copied code blocks without copying Markdown fences', () => {
    assert.equal(
        normalizeMarkdownForCopy('```js\nconst sku = "SKU-01";\n```'),
        'const sku = "SKU-01";'
    );
});
