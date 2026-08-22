import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createCustomerResponseStreamSanitizer,
    sanitizeCustomerResponse
} from '../services/conversation/customer-response-sanitizer.js';

test('removes internal tool identifiers from customer prose', () => {
    assert.equal(
        sanitizeCustomerResponse('searchProducts cho thấy có 8 sản phẩm. listCategories đã được dùng.'),
        ' cho thấy có 8 sản phẩm. đã được dùng.'
    );
});

test('does not leak an internal identifier split between stream chunks', () => {
    const sanitizer = createCustomerResponseStreamSanitizer();
    const output = [
        sanitizer.push('Kết quả searchPro'),
        sanitizer.push('ducts cho thấy có 8 sản phẩm.'),
        sanitizer.flush()
    ].join('');

    assert.equal(output, 'Kết quả cho thấy có 8 sản phẩm.');
    assert.doesNotMatch(output, /searchProducts/i);
});

test('removes guest-order tool identifiers from streamed customer prose', () => {
    const sanitizer = createCustomerResponseStreamSanitizer();
    const output = [
        sanitizer.push('I used updateGuestOrder'),
        sanitizer.push('Address after getGuestOrderDetails.'),
        sanitizer.flush()
    ].join('');

    assert.equal(output, 'I used after.');
    assert.doesNotMatch(output, /getGuestOrderDetails|updateGuestOrderAddress/i);
});

test('discards an unfinished temporary narration', () => {
    const sanitizer = createCustomerResponseStreamSanitizer();
    sanitizer.push('Tôi sẽ dùng searchProducts');
    sanitizer.discard();

    assert.equal(sanitizer.flush(), '');
});

test('removes database-unsafe decorative Unicode without changing Markdown links', () => {
    const output = sanitizeCustomerResponse('Đã xong 🛒 [Xem sản phẩm](https://afd.test/item.html)');

    assert.equal(output, 'Đã xong [Xem sản phẩm](https://afd.test/item.html)');
    assert.match(output, /\[Xem sản phẩm\]\(https:\/\/afd\.test\/item\.html\)/);
});

test('cleans malformed legacy icon placeholders before links', () => {
    assert.equal(
        sanitizeCustomerResponse('Hoàn tất nhé:???? [Xem sản phẩm](https://afd.test/item.html)'),
        'Hoàn tất nhé: [Xem sản phẩm](https://afd.test/item.html)'
    );
});
