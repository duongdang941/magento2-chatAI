import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const attachmentSource = fs.readFileSync(
    path.resolve(testDirectory, '../../view/frontend/web/js/chat/attachments.js'),
    'utf8'
);
const sandbox = { window: { AfdAiChat: {} } };
vm.runInNewContext(attachmentSource, sandbox);

function catalogContextPayload(text) {
    const marker = '[CATALOG_CONTEXT:';
    const start = String(text).indexOf(marker);
    const payloadStart = String(text).indexOf('\n', start);
    return JSON.parse(String(text).slice(payloadStart + 1));
}

test('uses the catalogue search icon while checking variant attributes', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: {},
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });

    assert.equal(methods.toolActivityIcon({ tool: 'listVariantAttributes' }), 'search');
});

test('catalog context preserves configurable attribute machine codes', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: {},
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });
    const history = methods.buildModelHistory.call({
        messages: [
            {
                role: 'assistant',
                parts: [{
                    type: 'products',
                    payload: {
                        items: [{
                            id: 890,
                            name: 'T-Shirt "#jetztafd"',
                            sku: 'N012.A0',
                            url: 'https://afd.test/t-shirt-jetzafd-2.html',
                            product_type: 'configurable',
                            requires_variant_selection: true,
                            variant_options: [
                                { code: 'farbe', label: 'Farbe', values: ['schwarz', 'weiß'] },
                                { code: 'grosse', label: 'Größe', values: ['S', 'M', 'L'] },
                                { code: 'gender', label: 'Geschlecht', values: ['Damen', 'Herren'] }
                            ]
                        }]
                    }
                }]
            },
            { role: 'user', content: 'Thêm giúp tôi phiên bản Herren.' }
        ],
        htmlToText: () => ''
    });

    const context = history[0].parts[0].text;
    assert.match(context, /\[CATALOG_CONTEXT:v2\]/);
    assert.match(context, /"code":"farbe","label":"Farbe","values":\["schwarz","weiß"\]/);
    assert.match(context, /"code":"grosse","label":"Größe","values":\["S","M","L"\]/);
    assert.match(context, /"code":"gender","label":"Geschlecht","values":\["Damen","Herren"\]/);
    assert.match(context, /"url":"https:\/\/afd\.test\/t-shirt-jetzafd-2\.html"/);
    assert.match(context, /exactly names one previously shown card/i);
    assert.match(context, /link\/open-page-only follow-up/i);
    const payload = catalogContextPayload(context);
    assert.deepEqual(payload.single_product_anchor, {
        product_ref: 'product:890',
        sku: 'N012.A0'
    });
    assert.match(payload.instruction, /language-neutral/i);
    assert.match(payload.instruction, /catalogContextDecision/);
    assert.match(payload.instruction, /followUpProductRef/);
});

test('catalog context creates no anchor when a grid contains multiple products', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: {},
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });
    const history = methods.buildModelHistory.call({
        messages: [
            {
                role: 'assistant',
                parts: [{
                    type: 'products',
                    payload: {
                        items: [
                            { id: 1, sku: 'FIRST-1', name: 'First product' },
                            { id: 2, sku: 'SECOND-2', name: 'Second product' }
                        ],
                        catalog_context: {
                            search_ref: 'search:0a1b2c3d4e5f6a7b8c9d0e1f',
                            request: {
                                query: 'printed items',
                                category_id: 17,
                                required_variant_attribute_code: 'farbe',
                                required_variant_option_values: ['schwarz']
                            }
                        }
                    }
                }]
            },
            { role: 'user', content: 'Does it come in another size?' }
        ],
        htmlToText: () => ''
    });

    const payload = catalogContextPayload(history[0].parts[0].text);
    assert.equal(Object.hasOwn(payload, 'single_product_anchor'), false);
    assert.deepEqual(payload.result_set_anchor, {
        search_ref: 'search:0a1b2c3d4e5f6a7b8c9d0e1f',
        request: {
            query: 'printed items',
            category_id: 17,
            required_variant_attribute_code: 'farbe',
            required_variant_option_values: ['schwarz']
        }
    });
});

test('catalog context keeps only the returned URL for an exact-title link follow-up', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: {},
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });
    const history = methods.buildModelHistory.call({
        messages: [
            {
                role: 'assistant',
                parts: [{
                    type: 'products',
                    payload: {
                        items: [{
                            id: 890,
                            name: 'T-Shirt "#jetztafd"',
                            sku: 'N012.A0',
                            url: 'https://afd.test/t-shirt-jetzafd-2.html',
                            price: '20,00 €'
                        }]
                    }
                }]
            },
            { role: 'user', content: 'Cho toi link san pham T-Shirt "#jetztafd"' }
        ],
        htmlToText: () => ''
    });

    const context = history[0].parts[0].text;
    assert.match(context, /"name":"T-Shirt \\\"#jetztafd\\\""/);
    assert.match(context, /"url":"https:\/\/afd\.test\/t-shirt-jetzafd-2\.html"/);
    assert.doesNotMatch(context, /20,00 €/);
});

test('candidate memory can be killed per store without removing the visible product card', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: { features: { candidate_memory_enabled: false } },
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });
    const history = methods.buildModelHistory.call({
        messages: [
            {
                role: 'assistant',
                parts: [{ type: 'text', raw: 'Here is the product.' }, {
                    type: 'products',
                    payload: { items: [{ id: 890, sku: 'N012.A0', name: 'T-Shirt' }] }
                }]
            },
            { role: 'user', content: 'Is it available?' }
        ],
        htmlToText: () => ''
    });

    assert.match(history[0].parts[0].text, /previous response displayed a verified product grid/i);
    assert.doesNotMatch(history[0].parts[0].text, /CATALOG_CONTEXT/);
});

test('does not feed an older text-only product list back as fresh catalogue evidence', () => {
    const methods = sandbox.window.AfdAiChat.attachmentMethods({
        config: {},
        urls: {},
        helpers: { MAX_MODEL_HISTORY_MESSAGES: 16 }
    });
    const history = methods.buildModelHistory.call({
        messages: [
            {
                role: 'assistant',
                parts: [{
                    type: 'text',
                    raw: 'There are 167 matching products. 1. Old product — 95 EUR.'
                }, {
                    type: 'products',
                    payload: {
                        items: [{
                            id: 99,
                            sku: 'OLD-99',
                            name: 'Old product',
                            price: '95 EUR'
                        }]
                    }
                }]
            },
            { role: 'user', content: 'Show me products I can add directly.' }
        ],
        htmlToText: () => ''
    });

    const priorAssistantMessage = history[0].parts[0].text;
    assert.match(priorAssistantMessage, /previous response displayed a verified product grid/i);
    assert.match(priorAssistantMessage, /PRIVATE REFERENCE LEDGER/i);
    assert.doesNotMatch(priorAssistantMessage, /167 matching products/i);
    assert.doesNotMatch(priorAssistantMessage, /95 EUR/i);
});
