import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseSafeWebUrl,
    searchWebWithAi
} from '../services/media/native-web-search.js';

const BASE_OPTIONS = {
    provider: 'cockpit',
    baseUrl: 'http://cockpit.test/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
};

test('safe URL parser blocks credentials, internal ports and private IP literals', () => {
    assert.equal(parseSafeWebUrl('https://user:secret@example.com/path'), null);
    assert.equal(parseSafeWebUrl('https://example.com:8443/path'), null);
    assert.equal(parseSafeWebUrl('http://[::1]/admin'), null);
    assert.equal(parseSafeWebUrl('http://[::ffff:7f00:1]/admin'), null);
    assert.equal(parseSafeWebUrl('https://docs.example.com/path')?.hostname, 'docs.example.com');
});

test('returns a bounded native web result with citations', async () => {
    let requestBody = null;
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'latest official Magento release',
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                output: [
                    { type: 'web_search_call', status: 'completed' },
                    {
                        type: 'message',
                        content: [{
                            type: 'output_text',
                            text: 'Magento published a release.',
                            annotations: [{
                                type: 'url_citation',
                                url: 'https://example.com/release',
                                title: 'Release notes'
                            }]
                        }]
                    }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(result.count, 1);
    assert.deepEqual(result.sources, [{ title: 'Release notes', url: 'https://example.com/release' }]);
    assert.deepEqual(requestBody.tools, [{ type: 'web_search' }]);
    assert.deepEqual(requestBody.tool_choice, { type: 'web_search' });
    assert.deepEqual(requestBody.include, ['web_search_call.action.sources']);
    assert.match(requestBody.input, /Request: latest official Magento release/);
    assert.match(requestBody.input, /Markdown link/);
});

test('uses Gemini Google Search grounding through the shared web-search tool', async () => {
    let requestUrl = '';
    let requestBody = null;
    const result = await searchWebWithAi({
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'test-key',
        model: 'gemini-2.5-flash',
        query: 'latest official Magento release',
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                candidates: [{
                    content: { parts: [{ text: 'Magento published a release.' }] },
                    groundingMetadata: {
                        groundingChunks: [{ web: { title: 'Release notes', uri: 'https://example.com/release' } }]
                    }
                }]
            }), { status: 200 });
        }
    });

    assert.equal(requestUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.deepEqual(requestBody.tools, [{ googleSearch: {} }]);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.sources, [{ title: 'Release notes', url: 'https://example.com/release' }]);
});

test('uses the selected 9router provider for ZCode-style search without separate configuration', async () => {
    let requestUrl = '';
    let requestBody = null;
    let authorization = '';
    const result = await searchWebWithAi({
        provider: 'gemini',
        baseUrl: 'https://9router.bingxgames.com/v1',
        apiKey: 'selected-provider-key',
        model: 'ag/gemini-3.6-flash-high',
        query: 'official Magento security release notes',
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestBody = JSON.parse(options.body);
            authorization = options.headers.Authorization;
            return new Response(JSON.stringify({
                provider: 'gemini',
                answer: null,
                results: [
                    {
                        title: 'Magento security bulletin',
                        url: 'https://example.com/security',
                        snippet: 'The official bulletin lists the patched release and publication date.'
                    },
                    {
                        title: 'Internal result',
                        url: 'http://127.0.0.1:8080/admin',
                        snippet: 'Must never reach the model.'
                    }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });

    assert.equal(requestUrl, 'https://9router.bingxgames.com/v1/search');
    assert.equal(authorization, 'Bearer selected-provider-key');
    assert.deepEqual(requestBody, {
        provider: 'gemini',
        query: 'official Magento security release notes',
        max_results: 5
    });
    assert.equal(result.status, 'success');
    assert.match(result.answer, /official bulletin lists the patched release/i);
    assert.deepEqual(result.sources, [{
        title: 'Magento security bulletin',
        url: 'https://example.com/security',
        excerpt: 'The official bulletin lists the patched release and publication date.'
    }]);
});

test('uses the built-in host search when 9router has no dedicated search credential', async () => {
    const requestedUrls = [];
    const result = await searchWebWithAi({
        provider: 'gemini',
        baseUrl: 'https://9router.bingxgames.com/v1',
        apiKey: 'selected-provider-key',
        model: 'ag/gemini-3.6-flash-high',
        query: 'current Magento release',
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url) => {
            requestedUrls.push(url);
            if (url.startsWith('https://9router.bingxgames.com/v1/search')) {
                return new Response(JSON.stringify({ error: { message: 'No credentials for provider: gemini' } }), { status: 400 });
            }
            return new Response([
                '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexperienceleague.adobe.com%2Freleases">Adobe release notes</a>',
                '<a class="result__snippet">Official release notes and supported versions.</a>'
            ].join(''), { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
    });

    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[1], /^https:\/\/html\.duckduckgo\.com\/html\/\?/);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.sources, [{
        title: 'Adobe release notes',
        url: 'https://experienceleague.adobe.com/releases',
        excerpt: 'Official release notes and supported versions.'
    }]);
});

test('uses Codex indexed search through Cockpit and returns safe excerpts for synthesis', async () => {
    let requestedUrl = '';
    let requestBody = null;
    let calls = 0;
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'current SJC gold price',
        fetchImpl: async (url, options) => {
            calls += 1;
            requestedUrl = url;
            requestBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                output: 'Internal formatted search output is not trusted directly.',
                results: [{
                    type: 'text_result',
                    title: 'SJC gold price today',
                    url: 'https://example.com/gold',
                    snippet: 'Buying price 136.5 million VND; selling price 140.5 million VND.'
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });

    assert.equal(calls, 1);
    assert.equal(requestedUrl, 'http://cockpit.test/v1/alpha/search');
    assert.deepEqual(requestBody.commands, {
        search_query: [{ q: 'current SJC gold price' }],
        response_length: 'medium'
    });
    assert.deepEqual(requestBody.settings, {
        allowed_callers: ['direct'],
        external_web_access: false
    });
    assert.equal(result.status, 'success');
    assert.match(result.answer, /Buying price 136\.5 million VND/);
    assert.equal(result.answer.includes('Internal formatted search output'), false);
    assert.deepEqual(result.sources, [{
        title: 'SJC gold price today',
        url: 'https://example.com/gold',
        excerpt: 'Buying price 136.5 million VND; selling price 140.5 million VND.'
    }]);
});

test('uses the built-in host search when Cockpit cannot provide external results', async () => {
    const requestedUrls = [];
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'Magento official release notes',
        fetchImpl: async (url) => {
            requestedUrls.push(url);
            if (url.includes('duckduckgo.com')) {
                return new Response([
                    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexperienceleague.adobe.com%2Freleases">Adobe release notes</a>',
                    '<a class="result__snippet">Official release notes and version information.</a>'
                ].join(''), { status: 200, headers: { 'Content-Type': 'text/html' } });
            }
            return new Response(JSON.stringify({ error: { message: 'Search unavailable' } }), { status: 404 });
        }
    });

    assert.equal(requestedUrls.length, 3);
    assert.match(requestedUrls[2], /^https:\/\/html\.duckduckgo\.com\/html\/\?/);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.sources, [{
        title: 'Adobe release notes',
        url: 'https://experienceleague.adobe.com/releases',
        excerpt: 'Official release notes and version information.'
    }]);
});

test('accepts a Cockpit final answer with a safe public Markdown source', async () => {
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'current OpenAI documentation title',
        fetchImpl: async () => new Response(JSON.stringify({
            output: [
                {
                    type: 'message',
                    phase: 'commentary',
                    content: [{ type: 'output_text', text: 'I will search now.' }]
                },
                {
                    type: 'message',
                    phase: 'final_answer',
                    content: [{
                        type: 'output_text',
                        text: 'Current documentation is available here.\n\nSource: [OpenAI API Documentation](https://developers.openai.com/api/docs/).',
                        annotations: []
                    }]
                }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    });

    assert.equal(result.status, 'success');
    assert.equal(result.answer.includes('I will search now'), false);
    assert.deepEqual(result.sources, [{
        title: 'OpenAI API Documentation',
        url: 'https://developers.openai.com/api/docs/'
    }]);
});

test('does not accept Cockpit compatibility output with only private URLs', async () => {
    let dnsCalled = false;
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'current service information',
        dnsLookup: async () => {
            dnsCalled = true;
            return [{ address: '127.0.0.1', family: 4 }];
        },
        fetchImpl: async () => new Response(JSON.stringify({
            output: [{
                type: 'message',
                phase: 'final_answer',
                content: [{
                    type: 'output_text',
                    text: 'Source: [Internal service](http://127.0.0.1:3000/admin)',
                    annotations: []
                }]
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'provider_web_search_unavailable');
    assert.equal(dnsCalled, false);
});

test('rejects a source hostname that resolves to a private address', async () => {
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'current service information',
        dnsLookup: async () => [{ address: '192.168.1.5', family: 4 }],
        fetchImpl: async () => new Response(JSON.stringify({
            output: [{
                type: 'message',
                phase: 'final_answer',
                content: [{
                    type: 'output_text',
                    text: 'Source: [Rebound host](https://public-looking.example.com/result)',
                    annotations: []
                }]
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.count, 0);
});

test('reports unsupported capability when a provider accepts the request without searching', async () => {
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'current weather',
        fetchImpl: async () => new Response(JSON.stringify({
            output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'I cannot access web search.', annotations: [] }]
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'provider_web_search_unavailable');
});

test('keeps normal chat safe when the responses endpoint is missing', async () => {
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'today news',
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        })
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'provider_web_search_temporarily_unavailable');
});

test('blocks private account and order data from a web query', async () => {
    let called = false;
    const result = await searchWebWithAi({
        ...BASE_OPTIONS,
        query: 'search order 000012345 for customer@example.com',
        fetchImpl: async () => {
            called = true;
            throw new Error('must not run');
        }
    });

    assert.equal(called, false);
    assert.equal(result.reason, 'private_data_blocked');
});
