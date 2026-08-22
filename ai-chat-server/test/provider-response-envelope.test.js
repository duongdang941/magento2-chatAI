import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addProviderCitations,
    createProviderResponseEnvelope,
    finalizeProviderResponseEnvelope,
    mergeProviderUsage,
    normalizeProviderResponseMetadata
} from '../services/orchestration/provider-response-envelope.js';
import { readOpenAiResponsesStream } from '../services/orchestration/openai-compatible-orchestrator.js';

test('normalizes provider usage and safe citations into one bounded envelope', () => {
    const envelope = createProviderResponseEnvelope({
        provider: 'cockpit-tool',
        protocol: 'openai-responses',
        model: 'gpt-5.6-terra',
        startedAt: Date.now() - 12
    });

    mergeProviderUsage(envelope, {
        input_tokens: 120,
        output_tokens: 48,
        total_tokens: 168,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 32 }
    });
    addProviderCitations(envelope, [
        { url: 'https://example.com/source', title: 'Source' },
        { url: 'http://insecure.example/source' },
        { url: 'https://example.com/source', title: 'Duplicate' }
    ]);

    const result = finalizeProviderResponseEnvelope(envelope, 'completed');
    assert.equal(result.provider, 'cockpit-tool');
    assert.equal(result.usage.total_tokens, 168);
    assert.equal(result.usage.cached_input_tokens, 20);
    assert.equal(result.usage.reasoning_tokens, 32);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].url, 'https://example.com/source');
    assert.equal(result.finish_reason, 'completed');
    assert.equal(Object.hasOwn(result, '_started_at'), false);
});

test('metadata normalization never preserves provider credentials or arbitrary payloads', () => {
    const result = normalizeProviderResponseMetadata({
        provider: 'custom',
        protocol: 'openai-responses',
        model: 'model-a',
        api_key: 'must-not-survive',
        usage: { prompt_tokens: 5, completion_tokens: 7 },
        citations: [{ url: 'https://example.com' }],
        raw_response: { secret: 'must-not-survive' }
    });

    assert.equal(result.api_key, undefined);
    assert.equal(result.raw_response, undefined);
    assert.equal(result.usage.total_tokens, 12);
    assert.equal(result.citations[0].url, 'https://example.com');
});

test('OpenAI Responses parser stops at response.completed without waiting for socket close', async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = {
        body: {
            getReader() {
                return {
                    async read() {
                        reads += 1;
                        if (reads === 1) {
                            return {
                                done: false,
                                value: encoder.encode([
                                    'data: {"type":"response.output_text.delta","delta":"Done"}\n\n',
                                    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n'
                                ].join(''))
                            };
                        }
                        throw new Error('The parser waited for an unnecessary socket close.');
                    }
                };
            }
        }
    };

    const chunks = [];
    const result = await readOpenAiResponsesStream(response, {
        onDelta: delta => chunks.push(delta),
        isCancelled: () => false
    });

    assert.equal(reads, 1);
    assert.equal(chunks[0].content, 'Done');
    assert.equal(result.finishReason, 'completed');
    assert.equal(result.usage.output_tokens, 2);
});
