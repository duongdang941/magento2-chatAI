import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('provider adapters do not own Magento persistence or tool schemas', () => {
    for (const filename of ['gemini-orchestrator.js', 'openai-compatible-orchestrator.js']) {
        const source = read('services', 'orchestration', filename);
        assert.doesNotMatch(source, /executeMagentoTool|createMagentoRequestConfig|axios/);
        assert.match(source, /ToolDefinitions/);
        assert.match(source, /createProviderNeutralToolFlow/);
    }
});

test('production code never logs raw model tool arguments', () => {
    for (const filename of ['gemini-orchestrator.js', 'openai-compatible-orchestrator.js']) {
        const source = read('services', 'orchestration', filename);
        assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*\bargs\b/);
    }
});

test('customer conversation touch remains bound to the verified owner', () => {
    const service = read('services', 'gateway', 'db-service.js');
    const contract = read('..', 'Api', 'ConversationManagementInterface.php');
    const model = read('..', 'Model', 'ConversationManagement.php');
    assert.match(service, /touchConversation\(conversationId, customerId/);
    assert.match(contract, /touchConversation\(int \$conversationId, int \$customerId\)/);
    assert.match(model, /getCustomerOwnedConversation\(\$conversationId, \$customerId\)/);
});

test('server composition root stays below the monolith regression budget', () => {
    const serverSource = read('server.js');
    const lines = serverSource.split('\n').length;
    assert.ok(lines < 1900, `server.js has regressed to ${lines} lines`);
    assert.match(read('services', 'conversation', 'history-message-preparer.js'), /activeAddressFormCacheKey/);
    assert.doesNotMatch(read('server.js'), /async function prepareHistoryMessages/);
    assert.doesNotMatch(serverSource, /async function handleVoiceTranscription/);
    assert.ok(
        serverSource.indexOf('const browserCartBridge = new BrowserCartBridge')
            < serverSource.indexOf('const connectionLifecycle = createConnectionLifecycle'),
        'connection lifecycle must be composed after the browser cart bridge'
    );
    assert.ok(
        serverSource.indexOf('} = createActiveRunController')
            < serverSource.indexOf('const connectionLifecycle = createConnectionLifecycle'),
        'connection lifecycle must be composed after cancelActiveRun exists'
    );
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

test('interactive conversation deletion is transactional and cleans files after database commit', () => {
    const source = read('..', 'Model', 'ConversationManagement.php');
    assert.match(source, /deleteConversationRows[\s\S]*beginTransaction\(\)[\s\S]*commit\(\)[\s\S]*rollBack\(\)/);
    assert.ok(
        source.indexOf('$this->deleteConversationRows($conversationId);')
            < source.indexOf('$this->chatAttachmentStorage->deleteConversationAttachments((int)$customerId, $conversationId);')
    );
});

test('frontend composition root delegates state and feature behaviour', () => {
    const compositionRoot = read('..', 'view', 'frontend', 'web', 'js', 'chat-interface.js');
    assert.ok(compositionRoot.split('\n').length < 60);
    assert.match(compositionRoot, /createInitialState/);
    assert.doesNotMatch(compositionRoot, /pendingGuestOrderAccessParts:\s*\[/);
});

test('storefront transports image bytes once and reads selected files sequentially', () => {
    const stream = read('..', 'view', 'frontend', 'web', 'js', 'chat', 'stream.js');
    const attachments = read('..', 'view', 'frontend', 'web', 'js', 'chat', 'attachments.js');
    assert.doesNotMatch(stream, /image:\s*outgoingAttachments\[0\]/);
    assert.doesNotMatch(stream, /images:[\s\S]{0,400}data:\s*attachment\.base64/);
    assert.doesNotMatch(attachments, /Promise\.all\(validFiles\.map/);
    assert.match(attachments, /for \(const file of validFiles\)[\s\S]*await this\.readImageAttachmentFile/);
    assert.match(attachments, /URL\.createObjectURL\(file\)/);
    assert.match(stream, /MAX_WEBSOCKET_PAYLOAD_BYTES/);
    assert.match(stream, /serializedChatPayload/);
});
