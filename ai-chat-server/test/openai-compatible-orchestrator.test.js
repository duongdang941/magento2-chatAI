import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatProviderError,
    isBlockingToolFailure,
    isRetryableProviderError,
    readOpenAiResponsesStream,
    resolveProviderConfig,
    resolveReachableBaseUrl,
    streamChatResponse
} from '../services/orchestration/openai-compatible-orchestrator.js';
import {
    GUEST_ORDER_AGENT_GUIDANCE,
    guestOrderAccessInstruction
} from '../services/customer/guest-order-access-guidance.js';
import {
    CATALOG_AGENT_GUIDANCE,
    MAX_CATALOG_TOOL_ROUNDS
} from '../services/catalog/catalog-agent-guidance.js';
import { RESPONSE_LANGUAGE_AGENT_GUIDANCE } from '../services/conversation/response-language-guidance.js';
import { buildAgentSystemInstruction } from '../services/orchestration/agent-system-guidance.js';
import {
    normalizeAvailabilityArguments,
    normalizeAddToCartArguments,
    normalizeRemoveFromCartArguments,
    normalizeSearchArguments
} from '../services/catalog/catalog-tool-arguments.js';
import { normalizeCustomerAddressArguments } from '../services/customer/customer-order-tool-arguments.js';

test('forwards OpenAI Responses reasoning summary deltas as thinking events', async () => {
    const payload = [
        'data: {"type":"response.reasoning_summary_text.delta","delta":"Phân tích "}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"đang chạy"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Kết luận"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    ].join('');
    let read = false;
    const response = {
        body: {
            getReader() {
                return {
                    async read() {
                        if (read) return { done: true, value: undefined };
                        read = true;
                        return { done: false, value: Buffer.from(payload) };
                    }
                };
            }
        }
    };
    const deltas = [];

    await readOpenAiResponsesStream(response, {
        onDelta: delta => deltas.push(delta),
        isCancelled: () => false
    });

    assert.deepEqual(deltas, [
        { reasoning: 'Phân tích ' },
        { reasoning: 'đang chạy' },
        { content: 'Kết luận' }
    ]);
});

test('uses only the custom provider endpoint without credential-bearing probes', async () => {
    const originalFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = async () => {
        probes += 1;
        return { ok: true };
    };

    try {
        const baseUrl = await resolveReachableBaseUrl({
            apiKey: 'merchant-secret',
            candidates: ['https://primary.example/v1/', 'https://fallback.example/v1']
        });
        assert.equal(baseUrl, 'https://primary.example/v1');
        assert.equal(probes, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('keeps a configurable package value separate from the cart-line quantity', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({
            sku: 'N054.A8B47',
            qty: 1,
            selectedOptions: { paketpreis: '500 Stk.' }
        }),
        {
            sku: 'N054.A8B47',
            qty: 1,
            cartTarget: 'checkout',
            selectedOptions: { paketpreis: '500 Stk.' }
        }
    );
});

test('uses Quote Cart only when the tool explicitly requests it', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'QUOTE-1', qty: 2, cartTarget: 'quote' }),
        { sku: 'QUOTE-1', qty: 2, cartTarget: 'quote' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CART-1', qty: 2, cartTarget: 'unexpected-value' }),
        { sku: 'CART-1', qty: 2, cartTarget: 'checkout' }
    );
});

test('lets Magento choose the default sale quantity when the shopper omitted quantity', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50' }, 'Thêm sản phẩm này vào giỏ hàng'),
        { sku: 'CARTON-50', qty: 1, useDefaultQty: true, cartTarget: 'checkout' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 1 }, 'Thêm sản phẩm này vào giỏ hàng'),
        { sku: 'CARTON-50', qty: 1, useDefaultQty: true, cartTarget: 'checkout' }
    );
});

test('preserves a shopper-explicit quantity for Magento validation', () => {
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 50 }, 'Thêm 50 sản phẩm này'),
        { sku: 'CARTON-50', qty: 50, cartTarget: 'checkout' }
    );
    assert.deepEqual(
        normalizeAddToCartArguments({ sku: 'CARTON-50', qty: 1 }, 'Thêm 1 sản phẩm này'),
        { sku: 'CARTON-50', qty: 1, cartTarget: 'checkout' }
    );
});

test('normalizes product removal to the correct storefront cart', () => {
    assert.deepEqual(
        normalizeRemoveFromCartArguments({ sku: ' REMOVE-1 ', cartTarget: 'quote' }),
        { action: 'remove', sku: 'REMOVE-1', cartTarget: 'quote' }
    );
    assert.deepEqual(
        normalizeRemoveFromCartArguments({ sku: 'REMOVE-2', cartTarget: 'unexpected-value' }),
        { action: 'remove', sku: 'REMOVE-2', cartTarget: 'checkout' }
    );
});

test('normalizes account address updates without accepting customer identity', () => {
    assert.deepEqual(normalizeCustomerAddressArguments({
        customerId: 999,
        addressType: 'shipping',
        address: {
            firstname: ' Ada ',
            country_id: 'de',
            street: [' First Street ', ' Apt 2 ']
        }
    }), {
        addressType: 'shipping',
        address: {
            firstname: 'Ada',
            country_id: 'DE',
            street: ['First Street', 'Apt 2']
        }
    });
});

test('formatProviderError exposes custom provider HTTP failures clearly', () => {
    assert.equal(
        formatProviderError(new Error('Base URL https://provider.example/v1 returned HTTP 502'), 'Merchant provider'),
        'Merchant provider endpoint returned HTTP 502. Please check the custom provider base URL in configuration.'
    );
});

test('retries only transient provider failures before any stream output', () => {
    assert.equal(isRetryableProviderError({ status: 504 }), true);
    assert.equal(isRetryableProviderError({ code: 'PROVIDER_STREAM_TIMEOUT' }), true);
    assert.equal(isRetryableProviderError(new Error('upstream timed out after 1m0s')), true);
    assert.equal(isRetryableProviderError({ status: 401 }), false);
});

test('does not abort normal chat when native Web Search is unavailable', () => {
    assert.equal(isBlockingToolFailure({ status: 'unavailable', reason: 'provider_web_search_unavailable' }), false);
    assert.equal(isBlockingToolFailure({ status: 'error', message: 'Provider failed' }), true);
    assert.equal(isBlockingToolFailure({ error: 'Network failed' }), true);

});

test('configures a custom OpenAI-compatible endpoint without built-in defaults', () => {
    const config = resolveProviderConfig({
        name: 'Merchant provider',
        api_key: 'test-openai-key',
        model: 'merchant-model',
        base_url: 'https://provider.example/v1/'
    });

    assert.equal(config.label, 'Merchant provider');
    assert.equal(config.apiKey, 'test-openai-key');
    assert.equal(config.model, 'merchant-model');
    assert.deepEqual(config.candidates, ['https://provider.example/v1']);
});

test('tells the provider when guest order access is already verified', () => {
    const instruction = guestOrderAccessInstruction(null, {
        token: 'a'.repeat(64),
        email: 'guest@example.test',
        sessionId: 'b'.repeat(64)
    });

    assert.match(instruction, /already been verified/i);
    assert.match(instruction, /Do not ask the shopper to verify/i);
    const unverifiedInstruction = guestOrderAccessInstruction(null, null);
    assert.match(unverifiedInstruction, /No verified checkout email/i);
    assert.match(unverifiedInstruction, /call the appropriate guest-order tool now/i);
    assert.match(unverifiedInstruction, /guest_access_required/i);
    assert.match(GUEST_ORDER_AGENT_GUIDANCE, /language they use/i);
    assert.match(GUEST_ORDER_AGENT_GUIDANCE, /Do not rely on fixed keywords/i);
});

test('defines human handoff as the verified private support portal', async () => {
    const { CATALOG_AGENT_GUIDANCE } = await import('../services/catalog/catalog-agent-guidance.js');
    const { buildAgentSystemInstruction } = await import('../services/orchestration/agent-system-guidance.js');
    const instruction = buildAgentSystemInstruction({ extendedTools: true });
    assert.match(instruction, /verified human-support portal/i);
    assert.match(instruction, /not an instant live-agent connection/i);
    assert.match(instruction, /never say support is unavailable/i);
    assert.ok(CATALOG_AGENT_GUIDANCE.length > 0);
});

test('uses a bounded, language-neutral catalogue retrieval protocol', () => {
    assert.equal(MAX_CATALOG_TOOL_ROUNDS, 8);
    assert.match(CATALOG_AGENT_GUIDANCE, /listCategories/);
    assert.match(CATALOG_AGENT_GUIDANCE, /Never repeat an identical call/);
    assert.doesNotMatch(CATALOG_AGENT_GUIDANCE, /hoodie|beachflag|fahnen|vật phẩm/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /unavailable_query_match/);
    assert.match(CATALOG_AGENT_GUIDANCE, /requires a fresh "searchProducts" call in the current turn/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /PRODUCT CARD CONTRACT/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /exactly names one previously shown card title/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /never add, suggest, recommend, or name another product/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /final supported retrieval has zero items/i);
    assert.match(buildAgentSystemInstruction(), /plain text\/Markdown only/i);
    assert.match(RESPONSE_LANGUAGE_AGENT_GUIDANCE, /grammatical\/request words/i);
    assert.match(RESPONSE_LANGUAGE_AGENT_GUIDANCE, /product name.*must never change/i);
});

test('adds Product Advisor guidance only when its store feature flag is enabled', async () => {
    const { buildAgentSystemInstruction } = await import('../services/orchestration/agent-system-guidance.js');
    const disabled = buildAgentSystemInstruction({ extendedTools: true });
    const enabled = buildAgentSystemInstruction({ extendedTools: true, productAdvisorEnabled: true });

    assert.doesNotMatch(disabled, /PRODUCT ADVISOR MODE/);
    assert.match(enabled, /PRODUCT ADVISOR MODE/);
    assert.match(enabled, /SKU\/product_ref/);
});

test('keeps structured price and configurable options out of language-specific query parsing', () => {
    assert.deepEqual(
        normalizeSearchArguments({ query: 'flags', maxPrice: 25 }, 6),
        { query: 'flags', maxPrice: 25, limit: 5, pageSize: 5, page: 1 }
    );
    assert.deepEqual(
        normalizeAvailabilityArguments({
            sku: 'SKU-1',
            selectedOptions: { finish: 'matte', material: 'cotton' }
        }),
        { sku: 'SKU-1', selectedOptions: '{"finish":"matte","material":"cotton"}' }
    );
});

test('custom OpenAI-compatible provider streams chunks and terminates with a done frame, never an error frame', async () => {
    const http = await import('node:http');
    const sseBody = [
        'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Xin chào"}}]}\n\n',
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" từ provider tùy chỉnh!"}}]}\n\n',
        'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n'
    ].join('');

    const server = http.createServer((request, response) => {
        assert.match(request.url, /\/chat\/completions$/);
        assert.equal(request.headers.authorization, 'Bearer test-key-123');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(sseBody);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

    const frames = [];
    const ws = { send: (frame) => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Có sản phẩm nào màu đen không' },
            ws,
            [],
            null,
            {
                provider: 'deepseek',
                name: 'Deepseek',
                base_url: baseUrl,
                api_key: 'test-key-123',
                model: 'deepseek-chat',
                api_format: 'openai-chat-completions'
            },
            {}
        );

        assert.equal(result.cancelled, false);
        assert.equal(result.error, undefined);
        const chunkText = frames
            .filter((frame) => frame.type === 'chunk')
            .map((frame) => frame.content)
            .join('');
        assert.match(chunkText, /Xin chào từ provider tùy chỉnh!/);
        assert.equal(
            frames.some((frame) => frame.type === 'error'),
            false,
            `unexpected error frames: ${JSON.stringify(frames.filter((frame) => frame.type === 'error'))}`
        );
        const done = frames.find((frame) => frame.type === 'done');
        assert.ok(done, 'terminal done frame must be sent after a successful turn');
        assert.equal(done.provider_meta?.finish_reason, 'stop');
        assert.equal(done.provider_meta?.provider, 'deepseek');
        assert.equal(done.provider_meta?.model, 'deepseek-chat');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('retries one final synthesis when a provider sends high-confidence prose in the wrong declared language', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'vi',
        runningLabel: 'Đang tìm sản phẩm {scope}',
        completedLabel: 'Đã tìm xong sản phẩm {scope}',
        failedLabel: 'Không thể tìm sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };
    const toolArguments = JSON.stringify({
        query: 'áo',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'vi',
        responseLanguageEvidence: ['Tôi', 'cần', 'áo'],
        activityPresentation
    });
    const providerReplies = [
        [
            `data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'search-1',
                            type: 'function',
                            function: { name: 'searchProducts', arguments: toolArguments }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            })}\n\n`,
            'data: [DONE]\n\n'
        ].join(''),
        [
            `data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: { content: 'Il modello ha trovato il prodotto richiesto e la disponibilità è stata verificata correttamente per il cliente.' },
                    finish_reason: 'stop'
                }]
            })}\n\n`,
            'data: [DONE]\n\n'
        ].join(''),
        [
            `data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: { content: 'Em đã tìm thấy sản phẩm theo yêu cầu. Thông tin hiển thị bên dưới được lấy từ dữ liệu cửa hàng hiện tại.' },
                    finish_reason: 'stop'
                }]
            })}\n\n`,
            'data: [DONE]\n\n'
        ].join('')
    ];
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[requests.length - 1]);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: (frame) => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Tôi cần áo', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                name: 'Custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'openai-chat-completions'
            },
            {
                executeMagentoTool: async () => ({
                    data: [{ id: 7, product_ref: 'product:7', sku: 'SHIRT-7', name: 'T-Shirt' }],
                    html: '<div class="product-card">T-Shirt</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                })
            }
        );

        assert.equal(result.cancelled, false);
        assert.equal(requests.length, 3);
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);
        const visibleText = frames
            .filter((frame) => frame.type === 'chunk')
            .map((frame) => frame.content)
            .join('');
        assert.match(visibleText, /Em đã tìm thấy sản phẩm/);
        assert.doesNotMatch(visibleText, /Il modello/);
        assert.equal(frames.some((frame) => frame.type === 'error'), false);
        assert.equal(frames.some((frame) => frame.type === 'done'), true);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('retries one empty provider turn with a tool-free synthesis after verified retrieval', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'vi',
        runningLabel: 'Đang tìm sản phẩm {scope}',
        completedLabel: 'Đã tìm xong sản phẩm {scope}',
        failedLabel: 'Không thể tìm sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };
    const toolArguments = JSON.stringify({
        query: 'áo',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'vi',
        responseLanguageEvidence: ['Tôi', 'cần', 'áo'],
        activityPresentation
    });
    const providerReplies = [
        [
            `data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'search-1',
                            type: 'function',
                            function: { name: 'searchProducts', arguments: toolArguments }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            })}\n\n`,
            'data: [DONE]\n\n'
        ].join(''),
        'data: [DONE]\n\n',
        [
            `data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: { content: 'Em đã tìm thấy sản phẩm theo yêu cầu và hiển thị kết quả bên dưới.' },
                    finish_reason: 'stop'
                }]
            })}\n\n`,
            'data: [DONE]\n\n'
        ].join('')
    ];
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[requests.length - 1]);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: (frame) => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Tôi cần áo', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                name: 'Custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'openai-chat-completions'
            },
            {
                executeMagentoTool: async () => ({
                    data: [{ id: 7, product_ref: 'product:7', sku: 'SHIRT-7', name: 'T-Shirt' }],
                    html: '<div class="product-card">T-Shirt</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                })
            }
        );

        assert.equal(result.cancelled, false);
        assert.equal(requests.length, 3);
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);
        assert.match(
            frames.filter((frame) => frame.type === 'chunk').map((frame) => frame.content).join(''),
            /Em đã tìm thấy sản phẩm/
        );
        assert.equal(frames.some((frame) => frame.type === 'error'), false);
        assert.equal(frames.some((frame) => frame.type === 'done'), true);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('runs the mandatory configurable availability read after the final normal tool round, then synthesizes', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Checking product {scope}',
        completedLabel: 'Checked product {scope}',
        failedLabel: 'Could not check product {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const searchArguments = JSON.stringify({
        query: 'T-Shirt "2. Wahl"',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'en',
        responseLanguageEvidence: ['Does', 'have', 'size'],
        activityPresentation
    });
    const availabilityArguments = JSON.stringify({
        sku: 'untrusted-sku',
        selectedOptions: { size: 'M' }
    });
    const toolCallSse = (id, name, argumentsJson) => [
        `data: ${JSON.stringify({
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: 0,
                        id,
                        type: 'function',
                        function: { name, arguments: argumentsJson }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        })}\n\n`,
        'data: [DONE]\n\n'
    ].join('');
    const textSse = (content) => [
        `data: ${JSON.stringify({
            choices: [{
                index: 0,
                delta: { content },
                finish_reason: 'stop'
            }]
        })}\n\n`,
        'data: [DONE]\n\n'
    ].join('');
    const providerReplies = [
        toolCallSse('search-1', 'searchProducts', searchArguments),
        toolCallSse('availability-1', 'getProductAvailability', availabilityArguments),
        textSse('Size M is currently available for this T-Shirt.')
    ];
    const requests = [];
    const executedTools = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[requests.length - 1]);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: (frame) => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Does T-Shirt "2. Wahl" have size M?', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                name: 'Custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'openai-chat-completions',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async (name, args) => {
                    executedTools.push({ name, args });
                    if (name === 'getProductAvailability') {
                        return {
                            data: [{
                                sku: 'N042.A104',
                                product_type: 'configurable',
                                availability: 'in_stock',
                                matching_variants: 1,
                                available_variants: 1
                            }]
                        };
                    }
                    if (name === 'searchProducts') {
                        return {
                            data: [{
                                id: 986,
                                sku: 'N042.A104',
                                name: 'T-Shirt "2. Wahl"',
                                product_type: 'configurable',
                                requires_variant_selection: true,
                                variant_options: [{ code: 'size', label: 'Size', values: ['M', 'XL'] }]
                            }],
                            html: '<div class="product-card">T-Shirt</div>',
                            meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                        };
                    }
                    throw new Error(`Unexpected Magento tool ${name}`);
                }
            }
        );

        assert.equal(result.cancelled, false);
        assert.deepEqual(executedTools.map(({ name }) => name), [
            'searchProducts',
            'getProductAvailability'
        ]);
        assert.equal(executedTools[1].args.sku, 'N042.A104');
        assert.equal(requests.length, 3);
        assert.equal(requests[1].tool_choice?.function?.name, 'getProductAvailability');
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);
        assert.equal(
            frames.some((frame) => frame.type === 'tool_activity'
                && frame.tool === 'getProductAvailability'
                && frame.state === 'running'
                && frame.language === 'en'),
            true
        );
        assert.match(
            frames.filter((frame) => frame.type === 'chunk').map((frame) => frame.content).join(''),
            /Size M is currently available/
        );
        assert.equal(frames.some((frame) => frame.type === 'error'), false);
        assert.equal(frames.some((frame) => frame.type === 'done'), true);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('formatProviderError points at base URL and model name for HTTP 404 rejections', () => {
    const message = formatProviderError(
        Object.assign(new Error('Not Found'), { status: 404 }),
        'Deepseek'
    );
    assert.match(message, /HTTP 404/);
    assert.match(message, /base URL/);
    assert.match(message, /model name/);
});
