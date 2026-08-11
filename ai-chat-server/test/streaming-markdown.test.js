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
const sandbox = { window: { AfdAiChat: {} } };
vm.runInNewContext(helperSource, sandbox);
const { normalizeMarkdownForCopy, stabilizeStreamingMarkdown } = sandbox.window.AfdAiChat.helpers;

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
