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

test('every provider reserves a tool-free final synthesis turn', () => {
    for (const filename of ['gemini-orchestrator.js', 'openai-compatible-orchestrator.js', 'anthropic-orchestrator.js']) {
        const source = read('services', 'orchestration', filename);
        assert.match(source, /isFinalSynthesisTurn/);
        assert.match(source, /FINAL_SYNTHESIS_INSTRUCTION/);
        assert.match(source, /iteration\s*<=\s*maxToolRounds/);
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
    assert.ok(lines < 1650, `server.js has regressed to ${lines} lines`);
    assert.match(read('services', 'conversation', 'history-message-preparer.js'), /activeAddressFormCacheKey/);
    assert.match(read('services', 'conversation', 'guest-history-sync.js'), /broadcastGuestConversation/);
    assert.match(read('services', 'customer', 'verified-access-session.js'), /supportEmailVerificationCacheKey/);
    assert.doesNotMatch(read('server.js'), /async function prepareHistoryMessages/);
    assert.doesNotMatch(read('server.js'), /async function hydrateGuestOrderAccess/);
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

test('storefront work history renders only verified customer action items', () => {
    const template = read('..', 'view', 'frontend', 'templates', 'chat', 'partials', 'conversation.phtml');
    assert.match(template, /reasoningTimeline\(part\)/);
    assert.match(template, /event\.type === 'activity'/);
    assert.doesNotMatch(template, /isProviderReasoningStep\(event\)/);
    assert.doesNotMatch(template, /renderStreamingMarkdown\(event\.content\)/);
    assert.doesNotMatch(template, /reasoningSteps\(part\)/);
});

test('assistant message actions stay hidden until their turn is hovered or focused', () => {
    const css = read('..', 'view', 'frontend', 'web', 'css', 'source', 'chat-widget', '_messages.less');
    assert.match(css, /\.afd-ai-chat__msg-actions--assistant\s*\{[\s\S]{0,700}opacity:\s*0;[\s\S]{0,160}pointer-events:\s*none;/);
    assert.match(css, /\.afd-ai-chat__msg-ai:hover \.afd-ai-chat__msg-actions,/);
    assert.match(css, /@media \(hover: none\)[\s\S]{0,400}\.afd-ai-chat__msg-actions\s*\{[\s\S]{0,160}opacity:\s*1;/);
});

test('does not mount a generated image until a completed URL is available', () => {
    const template = read('..', 'view', 'frontend', 'templates', 'chat', 'partials', 'conversation.phtml');
    const imageStream = read('..', 'view', 'frontend', 'web', 'js', 'chat', 'image-feedback-stream.js');

    assert.match(template, /<template x-if="part\.status !== 'generating' && part\.status !== 'error' && part\.url">\s*<figure class="afd-ai-chat__generated-image-result">/);
    assert.doesNotMatch(template, /<figure x-show="part\.status !== 'generating' && part\.status !== 'error' && part\.url"/);
    assert.match(imageStream, /if \(part\.status !== 'complete'[\s\S]{0,350}targetUrl && targetUrl !== url/);
});

test('provider model editor owns media capabilities and no longer hides output limits in Advanced', () => {
    const template = read('..', 'view', 'adminhtml', 'templates', 'provider', 'modal.phtml');
    const source = read('..', 'view', 'adminhtml', 'web', 'js', 'provider-modal.js');
    const systemXml = read('..', 'etc', 'adminhtml', 'system.xml');

    assert.ok(template.indexOf('zcodeSubMaxOutputTokens') < template.indexOf('zcode-model-capabilities'));
    assert.match(template, /zcodeSubCapabilityImage/);
    assert.match(template, /zcodeSubCapabilityVideo/);
    assert.match(template, /zcodeSubCapabilityVoice/);
    assert.doesNotMatch(template, /zcodeAdvancedToggle/);
    assert.match(source, /capabilities\]\[image_generation\]/);
    assert.match(source, /capabilities\]\[video_generation\]/);
    assert.match(source, /capabilities\]\[voice_dictation\]/);
    assert.doesNotMatch(systemXml, /image_generation_enabled/);
    assert.doesNotMatch(systemXml, /image_transport/);
});

test('a stopped response keeps a full gap before the following shopper message', () => {
    const template = read('..', 'view', 'frontend', 'templates', 'chat', 'partials', 'conversation.phtml');
    const css = read('..', 'view', 'frontend', 'web', 'css', 'source', 'chat-widget', '_messages.less');
    const entrypoint = read('..', 'view', 'frontend', 'web', 'css', 'chat-widget.less');

    assert.match(template, /class="afd-ai-chat__messages-content"/);
    assert.match(template, /class="afd-ai-chat__run-interruption"/);
    assert.match(css, /\.afd-ai-chat__messages-content\s*>\s*div\s*\+\s*div\s*\{\s*margin-top:\s*1\.05rem;/);
    assert.match(css, /\[data-ui-density="compact"\]\s+\.afd-ai-chat__messages-content\s*>\s*div\s*\+\s*div\s*\{\s*margin-top:\s*0\.7rem;/);
    assert.match(entrypoint, /\.afd-ai-chat__messages-content\s*>\s*div\s*\+\s*div\s*\{\s*margin-top:\s*1\.05rem;/);
    assert.match(entrypoint, /\[data-ui-density="compact"\]\s+\.afd-ai-chat__messages-content\s*>\s*div\s*\+\s*div\s*\{\s*margin-top:\s*0\.7rem;/);
});

test('every provider receives the current-turn language lock before it sees history', () => {
    for (const filename of ['gemini-orchestrator.js', 'openai-compatible-orchestrator.js', 'anthropic-orchestrator.js']) {
        const source = read('services', 'orchestration', filename);
        assert.match(source, /const currentUserText = String\(currentUserMessage\.text \|\| currentUserMessage\.content \|\| ''\);/);
        assert.match(source, /shopperMessage:\s*currentUserText/);
        assert.doesNotMatch(source, /type:\s*'thinking_delta'/);
    }
});

test('composer attachment previews open in the existing image viewer without removing the attachment', () => {
    const composer = read('..', 'view', 'frontend', 'templates', 'chat', 'partials', 'composer.phtml');
    const css = read('..', 'view', 'frontend', 'web', 'css', 'source', 'chat-widget', '_composer.less');
    assert.match(composer, /afd-ai-chat__attachment-preview-trigger/);
    assert.match(composer, /@click\.stop="openImageViewer\(imageAttachments, attachmentIndex\)"/);
    assert.match(composer, /@click\.stop="removeImageAttachment\(attachmentIndex\)"/);
    assert.match(css, /\.afd-ai-chat__attachment-preview-trigger\s*\{[\s\S]{0,500}cursor:\s*zoom-in;/);
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

test('storefront chat markup never embeds customer session state into an FPC page', () => {
    const template = read('..', 'view', 'frontend', 'templates', 'chat', 'interface.phtml');
    assert.match(template, /'customerId'\s*=>\s*null/);
    assert.match(template, /'isLoggedIn'\s*=>\s*false/);
    assert.doesNotMatch(template, /'customerId'\s*=>\s*\(int\)\s*\$block->getCustomerId\(\)/);
    assert.doesNotMatch(template, /'isLoggedIn'\s*=>\s*\$block->isLoggedIn\(\)/);
});

test('production edge examples enforce a replica-independent per-network connection limit', () => {
    const upstream = read('infra', 'nginx', 'production-upstream.conf.example');
    const websocket = read('infra', 'nginx', 'production-wss.conf.example');
    const localGateway = read('infra', 'nginx', 'gateway.conf');
    for (const source of [upstream, localGateway]) {
        assert.match(source, /limit_conn_zone\s+\$binary_remote_addr/);
    }
    for (const source of [websocket, localGateway]) {
        assert.match(source, /limit_conn\s+afd_ai_connection_limit\s+\d+/);
        assert.match(source, /limit_req\s+zone=afd_ai_connection_rate/);
    }
    assert.match(read('compose.yaml'), /TRUST_PROXY:\s+\$\{TRUST_PROXY:-1\}/);
});

test('generated-image cleanup uses an indexed reference table instead of message-text scans', () => {
    const cleaner = read('..', 'Model', 'Maintenance', 'ExpiredDataCleaner.php');
    const references = read('..', 'Model', 'Maintenance', 'GeneratedImageReferenceRepository.php');
    const schema = read('..', 'etc', 'db_schema.xml');
    assert.doesNotMatch(cleaner, /\bLIKE\b|afd_ai_message/);
    assert.match(references, /where\('filename = \?', \$filename\)/);
    assert.match(schema, /table name="afd_ai_generated_image_reference"/);
    assert.match(schema, /AFD_AI_GENERATED_IMAGE_REF_FILENAME/);
});

test('attachment cleanup scans both customer and guest private storage layouts', () => {
    const cleaner = read('..', 'Model', 'Maintenance', 'ChatAttachmentCleaner.php');
    assert.match(cleaner, /search\('\*\/\*\/\*', self::BASE_PATH\)/);
    assert.match(cleaner, /search\('\*\/\*\/\*\/\*', self::BASE_PATH\)/);
    assert.match(cleaner, /loadReferencedFiles/);
    assert.match(cleaner, /orphan_retention_seconds/);
    assert.match(cleaner, /usort\(\$candidates/);
    assert.match(cleaner, /cleanup_dry_run/);
    assert.match(cleaner, /protected_conversations/);
});

test('attachment writes reserve disk capacity before the final file write', () => {
    const storage = read('..', 'Model', 'ChatAttachmentStorage.php');
    const guard = read('..', 'Model', 'Maintenance', 'AttachmentDiskGuard.php');
    assert.ok(
        storage.indexOf('$this->diskGuard->assertCapacity') < storage.indexOf('base64_decode'),
        'the low-disk fast path must run before image decoding'
    );
    assert.match(storage, /reserveAndWrite\(/);
    assert.match(guard, /LockManagerInterface/);
    assert.match(guard, /assertOwnerQuota/);
});
