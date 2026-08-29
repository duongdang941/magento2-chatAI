import test from 'node:test';
import assert from 'node:assert/strict';

import { streamChatResponse } from '../services/orchestration/anthropic-orchestrator.js';

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
