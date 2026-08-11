import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('provider adapters do not own Magento persistence or tool schemas', () => {
    for (const filename of ['gemini-orchestrator.js', 'openai-compatible-orchestrator.js']) {
        const source = read('services', filename);
        assert.doesNotMatch(source, /executeMagentoTool|createMagentoRequestConfig|axios/);
        assert.match(source, /ToolDefinitions/);
        assert.match(source, /executeRegisteredMagentoTool/);
    }
});

test('server composition root stays below the monolith regression budget', () => {
    const lines = read('server.js').split('\n').length;
    assert.ok(lines < 1900, `server.js has regressed to ${lines} lines`);
    assert.match(read('services', 'history-message-preparer.js'), /activeAddressFormCacheKey/);
    assert.doesNotMatch(read('server.js'), /async function prepareHistoryMessages/);
});

test('optional quote extension is isolated behind a Magento adapter', () => {
    const cartTool = read('..', 'Model', 'Tool', 'CartTool.php');
    const adapter = read('..', 'Model', 'Cart', 'OptionalQuoteCartAdapter.php');
    assert.doesNotMatch(cartTool, /Amasty\\RequestQuote/);
    assert.match(adapter, /Amasty\\RequestQuote/);
});

test('conversation deletion explicitly removes messages before the SET NULL legacy FK can orphan them', () => {
    const eraser = read('..', 'Model', 'Privacy', 'ConversationDataEraser.php');
    assert.match(eraser, /getTableName\('afd_ai_message'\)[\s\S]*getTableName\('afd_ai_conversation'\)/);
});

test('frontend composition root delegates state and feature behaviour', () => {
    const compositionRoot = read('..', 'view', 'frontend', 'web', 'js', 'chat-interface.js');
    assert.ok(compositionRoot.split('\n').length < 60);
    assert.match(compositionRoot, /createInitialState/);
    assert.doesNotMatch(compositionRoot, /pendingGuestOrderAccessParts:\s*\[/);
});
