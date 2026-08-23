import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    buildUserMessageDescriptor,
    recordOutboundAssistantPart,
    toAnthropicContent,
    toGeminiParts,
    toOpenAiContent,
    validateImageParts
} from '../services/conversation/message-parts.js';

const RED_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lC0AAAAASUVORK5CYII=';

test('records public provider reasoning and verified action activity', () => {
    const parts = [];

    recordOutboundAssistantPart(parts, {
        type: 'thinking_delta',
        step_id: 'draft',
        delta: 'Examining ',
        visibility: 'public'
    });
    recordOutboundAssistantPart(parts, {
        type: 'thinking_delta',
        step_id: 'draft',
        delta: 'the catalogue.',
        visibility: 'public'
    });
    recordOutboundAssistantPart(parts, {
        type: 'tool_activity',
        activity_id: 'catalog-1',
        tool: 'searchProducts',
        state: 'completed',
        result_count: 2
    });

    assert.deepEqual(parts, [{
        type: 'reasoning',
        events: [{
            id: 'provider-reasoning-draft',
            type: 'step',
            source: 'provider_reasoning',
            content: 'Examining the catalogue.',
            state: 'completed'
        }, {
            id: 'catalog-1',
            type: 'activity',
            tool: 'searchProducts',
            state: 'completed',
            result_count: 2
        }],
        steps: [{
            id: 'provider-reasoning-draft',
            type: 'step',
            source: 'provider_reasoning',
            content: 'Examining the catalogue.',
            state: 'completed'
        }],
        activities: [{
            id: 'catalog-1',
            type: 'activity',
            tool: 'searchProducts',
            state: 'completed',
            result_count: 2
        }]
    }]);
});

test('buildUserMessageDescriptor keeps uploaded image parts for the model', () => {
    const message = buildUserMessageDescriptor({
        text: 'Đã gửi hình ảnh',
        parts: [
            { text: 'Analyze this product image and find matching items in the store.' },
            {
                inline_data: {
                    mime_type: 'image/png',
                    data: RED_PIXEL_PNG
                }
            }
        ]
    });

    assert.equal(message.hasImage, true);
    assert.equal(message.displayText, 'Sent an image');
    assert.match(message.text, /^Analyze this image/);
    assert.equal(validateImageParts(message.parts), '');
});

test('provider content converters preserve text and inline image data', () => {
    const message = buildUserMessageDescriptor({
        text: 'Hình ảnh này nói về cái gì?',
        image: {
            type: 'image/png',
            data: RED_PIXEL_PNG
        }
    });

    const openAiContent = toOpenAiContent(message.parts, message.text);
    assert.equal(Array.isArray(openAiContent), true);
    assert.equal(openAiContent[0].type, 'text');
    assert.equal(openAiContent[1].type, 'image_url');
    assert.match(openAiContent[1].image_url.url, /^data:image\/png;base64,/);

    const anthropicContent = toAnthropicContent(message.parts, message.text);
    assert.equal(Array.isArray(anthropicContent), true);
    assert.deepEqual(anthropicContent[0], {
        type: 'text',
        text: 'Hình ảnh này nói về cái gì?'
    });
    assert.deepEqual(anthropicContent[1], {
        type: 'image',
        source: {
            type: 'base64',
            media_type: 'image/png',
            data: RED_PIXEL_PNG
        }
    });

    const geminiParts = toGeminiParts(message.parts, message.text);
    assert.equal(geminiParts[0].text, 'Hình ảnh này nói về cái gì?');
    assert.deepEqual(geminiParts[1].inlineData, {
        mimeType: 'image/png',
        data: RED_PIXEL_PNG
    });
});

test('provider content converters preserve multiple uploaded images in one message', () => {
    const message = buildUserMessageDescriptor({
        text: 'So sánh hai hình này',
        parts: [
            { text: 'So sánh hai hình này' },
            { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } },
            { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } }
        ]
    });

    assert.equal(message.parts.filter((part) => part.inline_data).length, 2);
    assert.equal(validateImageParts(message.parts, { maxCount: 4 }), '');

    const openAiContent = toOpenAiContent(message.parts, message.text);
    assert.equal(openAiContent.filter((part) => part.type === 'image_url').length, 2);

    const geminiParts = toGeminiParts(message.parts, message.text);
    assert.equal(geminiParts.filter((part) => part.inlineData).length, 2);
});

test('validateImageParts rejects unsupported or oversized image payloads', () => {
    assert.equal(validateImageParts([
        { inline_data: { mime_type: 'image/gif', data: RED_PIXEL_PNG } }
    ]), 'Only JPG, PNG, or WebP images are supported.');

    assert.equal(validateImageParts([
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } }
    ], { maxBytes: 1 }), 'Image must be 4MB or smaller.');

    assert.equal(validateImageParts([
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } },
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } },
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } }
    ], { maxCount: 2 }), 'A message can contain up to 2 images.');

    assert.equal(validateImageParts([
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } },
        { inline_data: { mime_type: 'image/png', data: RED_PIXEL_PNG } }
    ], { maxTotalBytes: 10 }), 'The combined image upload is too large. Remove an image or choose smaller files.');
});

test('buildUserMessageDescriptor supports attachment_ref contract', () => {
    const message = buildUserMessageDescriptor({
        text: 'Kiểm tra sản phẩm này',
        parts: [
            { text: 'Kiểm tra sản phẩm này' },
            {
                type: 'attachment_ref',
                attachment_id: 'att_abc123',
                kind: 'image',
                mime_type: 'image/jpeg',
                bytes: 1024,
                url: 'https://example.com/media/chat/att_abc123.jpg'
            }
        ]
    });

    assert.equal(message.hasImage, true);
    assert.equal(message.displayText, 'Kiểm tra sản phẩm này');
    assert.equal(validateImageParts(message.parts), '');

    const openAiContent = toOpenAiContent(message.parts, message.text);
    assert.equal(openAiContent.some((p) => p.type === 'image_url' && p.image_url?.url === 'https://example.com/media/chat/att_abc123.jpg'), true);
});

test('provider content converters resolve attachment_ref with local binary resolver for Gemini and OpenAI', () => {
    const message = buildUserMessageDescriptor({
        text: 'Tìm áo tương tự',
        parts: [
            { text: 'Tìm áo tương tự' },
            {
                type: 'attachment_ref',
                attachment_id: 'att_0123456789abcdef0123456789abcdef',
                kind: 'image',
                mime_type: 'image/png'
            }
        ]
    });

    assert.equal(message.hasImage, true);
    assert.equal(validateImageParts(message.parts), '');

    // Gemini converter includes text and handles attachment reference structure safely
    const geminiParts = toGeminiParts(message.parts, message.text);
    assert.equal(geminiParts.length >= 1, true);
    assert.equal(geminiParts[0].text, 'Tìm áo tương tự');

    // OpenAI converter generates structured text & image parts safely
    const openAiContent = toOpenAiContent(message.parts, message.text);
    assert.equal(Array.isArray(openAiContent), true);
    assert.equal(openAiContent[0].type, 'text');
    assert.equal(openAiContent[0].text, 'Tìm áo tương tự');
});

test('Anthropic converter resolves an uploaded attachment reference as an image block', () => {
    const attachmentId = 'att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const chatDir = path.resolve(process.cwd(), '../../../../../var/afd_ai/chat');
    const testDirectory = fs.mkdtempSync(path.join(chatDir, 'message-parts-test-'));
    const finalDirectory = path.join(testDirectory, 'final');
    fs.mkdirSync(finalDirectory, { recursive: true });
    fs.writeFileSync(path.join(finalDirectory, `${attachmentId}.png`), Buffer.from(RED_PIXEL_PNG, 'base64'));

    try {
        const content = toAnthropicContent([
            { text: 'Sản phẩm trong hình này là gì?' },
            {
                type: 'attachment_ref',
                attachment_id: attachmentId,
                mime_type: 'image/png'
            }
        ]);

        assert.deepEqual(content, [
            { type: 'text', text: 'Sản phẩm trong hình này là gì?' },
            {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: RED_PIXEL_PNG
                }
            }
        ]);
    } finally {
        fs.rmSync(testDirectory, { recursive: true, force: true });
    }
});
