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
});
