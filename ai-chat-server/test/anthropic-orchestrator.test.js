import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isRetryableInitialProviderError,
    streamChatResponse
} from '../services/orchestration/anthropic-orchestrator.js';

test('retries only an initial transient Anthropic-compatible provider failure', async () => {
    const http = await import('node:http');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const responseBody = [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Verified reply.' } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
        requestCount += 1;
        if (requestCount === 1) {
            response.writeHead(502, { 'Content-Type': 'text/plain' });
            response.end('temporary gateway failure');
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(responseBody);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Reply after a transient error.', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: `http://127.0.0.1:${server.address().port}/v1`,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            }
        );

        assert.equal(result.error, undefined);
        // The first provider request is a 502. A successful streamed reply
        // proves that the adapter issued a new request instead of exposing
        // that upstream failure to the shopper. Additional calls can be
        // legitimate protocol-only final-synthesis repairs.
        assert.ok(requestCount >= 2);
        assert.equal(frames.filter(frame => frame.type === 'chunk').map(frame => frame.content).join(''), 'Verified reply.');
        assert.equal(frames.at(-1).type, 'done');
        assert.equal(isRetryableInitialProviderError({ status: 502 }), true);
        assert.equal(isRetryableInitialProviderError({ status: 401 }), false);
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('recovers several empty Anthropic-compatible turns without replaying a Magento tool', async () => {
    const http = await import('node:http');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const textReply = [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Recovered customer response.' } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const replies = ['', '', textReply];
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(replies[requestCount++] || textReply);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const frames = [];
    const executedTools = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Please provide the verified response.', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: `http://127.0.0.1:${server.address().port}/v1`,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async (...args) => {
                    executedTools.push(args);
                    throw new Error('An empty provider recovery must not execute a Magento tool.');
                }
            }
        );

        assert.equal(result.emptyResponse, undefined);
        // The three empty/text replies exercise the recovery. Subsequent
        // provider-only validation turns are allowed, but the Magento tool
        // ledger must remain untouched throughout.
        assert.ok(requestCount >= 3);
        assert.deepEqual(executedTools, []);
        assert.equal(frames.filter(frame => frame.type === 'chunk').map(frame => frame.content).join(''), 'Recovered customer response.');
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('performs gateway-owned availability when an Anthropic relay ignores forced tool choice', async () => {
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
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const providerReplies = [
        toolUseSse('search-1', 'searchProducts', searchArguments),
        textSse('The search card says that size M is in stock.'),
        textSse('Live Magento availability requires the remaining variant choices before stock can be confirmed.')
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Does T-Shirt "2. Wahl" have size M?', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async (name, args) => {
                    executedTools.push({ name, args });
                    if (name === 'getProductAvailability') {
                        return { data: [{ sku: 'N042.A104', availability: 'requires_variant_selection' }] };
                    }
                    if (name === 'searchProducts') {
                        return {
                            data: [{
                                sku: 'N042.A104',
                                name: 'T-Shirt "2. Wahl"',
                                product_type: 'configurable',
                                requires_variant_selection: true,
                                variant_options: [{ code: 'size', label: 'Size', values: ['M', 'XL'] }]
                            }],
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
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);
        const visibleText = frames
            .filter(frame => frame.type === 'chunk')
            .map(frame => frame.content)
            .join('');
        assert.match(visibleText, /Live Magento availability/);
        assert.doesNotMatch(visibleText, /search card says/i);
        assert.equal(frames.some(frame => frame.type === 'done'), true);
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('retries a skipped structured multi-card anchor decision before publishing shopper prose', async () => {
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
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const providerReplies = [
        textSse('I will decide whether to check the catalogue.'),
        toolUseSse('catalog-need-1', 'resolveCatalogNeed', JSON.stringify({
            decision: 'catalog_search'
        })),
        textSse('I will check the Windbreaker stock for you.'),
        textSse('I will verify the selected card before answering.'),
        toolUseSse('resolve-1', 'resolveCatalogAnchor', JSON.stringify({
            decision: 'select_product',
            productRef: 'product:7'
        })),
        toolUseSse('search-1', 'searchProducts', JSON.stringify({
            query: 'N022.B00',
            catalogIntent: 'product_search',
            exactIdentity: false,
            catalogContextDecision: 'follow_up',
            followUpProductRef: 'product:7',
            responseLanguage: 'en',
            responseLanguageEvidence: ['How', 'many', 'left'],
            activityPresentation
        })),
        textSse('The card says that this Windbreaker is available.'),
        textSse('Live Magento availability confirms that the selected Windbreaker is available.')
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'How many of the Windbreaker individualisierbar are left?', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 4 }
            },
            {
                resultSetAnchor: {
                    searchRef: 'search:0123456789abcdef01234567',
                    request: { query: 'Windbreaker' },
                    products: [{ productRef: 'product:7', sku: 'N022.B00' }]
                },
                executeMagentoTool: async (name, args) => {
                    executedTools.push({ name, args });
                    if (name === 'searchProducts') {
                        return {
                            data: [{
                                sku: 'N022.B00',
                                name: 'Windbreaker individualisierbar',
                                product_type: 'configurable',
                                requires_variant_selection: true
                            }],
                            meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                        };
                    }
                    if (name === 'getProductAvailability') {
                        return { data: [{ sku: 'N022.B00', availability: 'in_stock' }] };
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
        assert.equal(requests[0].tool_choice.name, 'resolveCatalogNeed');
        assert.equal(requests[1].tool_choice.name, 'resolveCatalogNeed');
        assert.equal(requests[2].tool_choice.name, 'resolveCatalogAnchor');
        assert.equal(requests[3].tool_choice.name, 'resolveCatalogAnchor');
        assert.equal(requests[4].tool_choice.name, 'resolveCatalogAnchor');
        assert.equal(requests.length, 8);
        const visibleText = frames
            .filter(frame => frame.type === 'chunk')
            .map(frame => frame.content)
            .join('');
        assert.match(visibleText, /Live Magento availability/);
        assert.doesNotMatch(visibleText, /I will check/i);
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('falls back to a structural catalog-search decision after a relay repeatedly skips it', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Searching products {scope}',
        completedLabel: 'Finished searching products {scope}',
        failedLabel: 'Could not search products {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const searchArguments = JSON.stringify({
        query: 'T-Shirt',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'en',
        responseLanguageEvidence: ['Do', 'you', 'have', 'shirts'],
        activityPresentation
    });
    const providerReplies = [
        ...Array.from({ length: 3 }, () => textSse('I will search the catalogue.')),
        toolUseSse('search-1', 'searchProducts', searchArguments),
        textSse('Here is the current verified result.')
    ];
    const requests = [];
    const executedTools = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[Math.min(requests.length - 1, providerReplies.length - 1)]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Do you have T-Shirts?', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: `http://127.0.0.1:${server.address().port}/v1`,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 2 }
            },
            {
                executeMagentoTool: async (name, args) => {
                    executedTools.push({ name, args });
                    if (name !== 'searchProducts') throw new Error(`Unexpected Magento tool ${name}`);
                    return {
                        data: [{ sku: 'TS-1', name: 'Current T-Shirt', product_type: 'simple' }],
                        meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                    };
                }
            }
        );

        assert.equal(result.cancelled, false);
        assert.deepEqual(executedTools.map(({ name }) => name), ['searchProducts']);
        assert.equal(requests[3].tool_choice.name, 'searchProducts');
        assert.equal(requests[4].tools, undefined);
        const visibleText = frames
            .filter(frame => frame.type === 'chunk')
            .map(frame => frame.content)
            .join('');
        assert.equal(visibleText, 'Here is the current verified result.');
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('recovers a tool-free Anthropic synthesis when a relay emits a stale tool call', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Searching products {scope}',
        completedLabel: 'Finished searching products {scope}',
        failedLabel: 'Could not search products {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const searchArguments = JSON.stringify({
        query: 'Luftballons',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'en',
        responseLanguageEvidence: ['Please', 'show', 'products'],
        activityPresentation
    });
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const providerReplies = [
        toolUseSse('search-1', 'searchProducts', searchArguments),
        // This is intentionally invalid for a synthesis-only request. The
        // adapter must close it with a rejected tool_result before retrying;
        // otherwise an Anthropic-compatible relay can replay it until the
        // shopper receives response_empty.
        toolUseSse('stale-tool-1', 'searchProducts', '{}'),
        textSse('The store has a suitable Luftballons product, and the verified product card is shown below for you.')
    ];
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[requests.length - 1]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Please show me Luftballons products.', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async () => ({
                    data: [{ sku: '021.A403', name: 'Luftballons', product_type: 'simple' }],
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                })
            }
        );

        assert.equal(result.cancelled, false);
        assert.equal(requests.length, 3);
        assert.equal(Object.hasOwn(requests[1], 'tools'), false);
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);

        const repairMessages = requests[2].messages;
        assert.equal(repairMessages.at(-3).role, 'user');
        const retainedToolResult = repairMessages.at(-3).content[0];
        assert.equal(retainedToolResult.type, 'tool_result');
        assert.equal(retainedToolResult.tool_use_id, 'search-1');
        const retainedMagentoContext = JSON.parse(retainedToolResult.content);
        assert.equal(retainedMagentoContext.products[0].sku, '021.A403');
        assert.equal(repairMessages.at(-2).role, 'assistant');
        assert.equal(repairMessages.at(-2).content[0].id, 'stale-tool-1');
        assert.equal(repairMessages.at(-1).role, 'user');
        const rejectedToolResult = repairMessages.at(-1).content[0];
        assert.deepEqual(rejectedToolResult, {
            type: 'tool_result',
            tool_use_id: 'stale-tool-1',
            is_error: true,
            content: JSON.stringify({
                status: 'rejected',
                reason: 'Tool execution is complete. Answer from the verified results already in the conversation.'
            })
        });
        assert.deepEqual(repairMessages.at(-1).content.at(-1), {
            type: 'text',
            text: 'No tool can run in this turn because tool execution is complete. Use the verified results already in the conversation and provide the shopper-facing response now without a tool call.'
        });
        assert.match(
            frames.filter(frame => frame.type === 'chunk').map(frame => frame.content).join(''),
            /Luftballons/
        );
        assert.equal(frames.some(frame => frame.type === 'error'), false);
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('retries the full bounded stale Anthropic synthesis sequence without spending extra Magento tool rounds', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Searching products {scope}',
        completedLabel: 'Finished searching products {scope}',
        failedLabel: 'Could not search products {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const searchArguments = JSON.stringify({
        query: 'Luftballons',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'en',
        responseLanguageEvidence: ['Please', 'show', 'products'],
        activityPresentation
    });
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const providerReplies = [
        toolUseSse('search-1', 'searchProducts', searchArguments),
        ...Array.from(
            { length: 8 },
            (_, index) => toolUseSse(`stale-tool-${index + 1}`, 'searchProducts', '{}')
        ),
        textSse('The verified Luftballons product is shown below for you.')
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Please show me Luftballons products.', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async (name) => {
                    executedTools.push(name);
                    return {
                        data: [{ sku: '021.A403', name: 'Luftballons', product_type: 'simple' }],
                        meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                    };
                }
            }
        );

        assert.equal(result.cancelled, false);
        assert.deepEqual(executedTools, ['searchProducts']);
        assert.equal(requests.length, 10);
        for (const request of requests.slice(1)) {
            assert.equal(Object.hasOwn(request, 'tools'), false);
        }
        const finalHistory = requests.at(-1).messages.at(-1).content;
        assert.deepEqual(
            finalHistory.filter(({ type }) => type === 'tool_result').map(({ tool_use_id }) => tool_use_id),
            ['stale-tool-8']
        );
        assert.equal(finalHistory[0].is_error, true);
        const rejectedCalls = requests.at(-1).messages
            .flatMap((message) => Array.isArray(message.content) ? message.content : [])
            .filter(({ type, is_error }) => type === 'tool_result' && is_error === true);
        assert.deepEqual(
            rejectedCalls.map(({ tool_use_id }) => tool_use_id),
            Array.from({ length: 8 }, (_, index) => `stale-tool-${index + 1}`)
        );
        assert.match(
            frames.filter(frame => frame.type === 'chunk').map(frame => frame.content).join(''),
            /verified Luftballons/
        );
        assert.equal(frames.some(frame => frame.type === 'error'), false);
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});

test('repairs an Anthropic final price that is absent from the rendered Magento cards', async () => {
    const http = await import('node:http');
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Searching products {scope}',
        completedLabel: 'Finished searching products {scope}',
        failedLabel: 'Could not search products {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const searchArguments = JSON.stringify({
        query: 'print product',
        catalogIntent: 'product_search',
        exactIdentity: false,
        responseLanguage: 'en',
        responseLanguageEvidence: ['Please', 'show'],
        activityPresentation
    });
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const toolUseSse = (id, name, input) => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'tool_use', id, name } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: input } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const textSse = text => [
        event('content_block_start', { type: 'content_block_start', content_block: { type: 'text' } }),
        event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } }),
        event('content_block_stop', { type: 'content_block_stop' }),
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    ].join('');
    const providerReplies = [
        toolUseSse('search-1', 'searchProducts', searchArguments),
        textSse('The cheapest matching print product costs 38 €.'),
        textSse('The verified matching print product costs 0,40 €.')
    ];
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(providerReplies[requests.length - 1]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const frames = [];
    const ws = { send: frame => frames.push(JSON.parse(frame)) };

    try {
        const result = await streamChatResponse(
            { text: 'Please show a print product.', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'custom',
                base_url: baseUrl,
                api_key: 'test-key',
                model: 'test-model',
                api_format: 'anthropic-messages',
                agent: { max_tool_rounds: 1 }
            },
            {
                executeMagentoTool: async () => ({
                    data: [{ id: 5091, sku: 'N024.B5091', name: 'Kurzprogramm der AfD', price: '0.40' }],
                    html: '<div class="product-card">Kurzprogramm der AfD</div>',
                    meta: {
                        currency: { code: 'EUR' },
                        pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false }
                    }
                })
            }
        );

        assert.equal(result.cancelled, false);
        assert.equal(requests.length, 3);
        assert.equal(Object.hasOwn(requests[1], 'tools'), false);
        assert.equal(Object.hasOwn(requests[2], 'tools'), false);
        assert.match(JSON.stringify(requests[2].messages), /not present in the current verified Magento product cards/i);
        const visibleText = frames.filter(frame => frame.type === 'chunk').map(frame => frame.content).join('');
        assert.match(visibleText, /0,40 €/);
        assert.doesNotMatch(visibleText, /38 €/);
        assert.equal(frames.some(frame => frame.type === 'error'), false);
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});
