import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChatResponse } from '../services/orchestration/anthropic-orchestrator.js';

const sse = (events) => events.map((event) => `data: ${event}`).join('\n\n') + '\n\n';

test('replays signed thinking and redacted thinking blocks on later tool rounds', async () => {
    const roundOne = sse([
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need evidence' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'encrypted-redacted' } }),
        JSON.stringify({ type: 'content_block_stop', index: 1 }),
        JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchWeb' } }),
        JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":""}' } }),
        JSON.stringify({ type: 'content_block_stop', index: 2 }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
    ]);
    const roundTwo = sse([
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final customer answer' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })
    ]);

    const requests = [];
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), body: JSON.parse(init.body || '{}') });
        call += 1;
        const payload = call === 1 ? roundOne : roundTwo;
        let read = false;
        return {
            ok: true,
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
    };

    try {
        const frames = [];
        const ws = { send: (raw) => frames.push(JSON.parse(raw)) };
        // The empty searchWeb query is blocked by the commerce guardrail as a
        // non-blocking outcome, so the second provider turn still runs.
        const result = await streamChatResponse(
            { text: 'Search the web for me', parts: [] },
            ws,
            [],
            null,
            {
                provider: 'anthropic',
                api_key: 'test-key',
                base_url: 'https://anthropic.test',
                thought_level: 'medium'
            },
            {}
        );

        assert.equal(result.cancelled, false);
        assert.equal(requests.length, 2);

        // Unsigned thinking blocks are rejected by Anthropic on follow-up
        // requests, so both the captured signature and the opaque
        // redacted_thinking block must be replayed verbatim.
        const assistantContent = requests[1].body.messages.find((m) => m.role === 'assistant')?.content;
        assert.ok(Array.isArray(assistantContent));
        assert.deepEqual(
            assistantContent.filter((block) => block.type === 'thinking'),
            [{ type: 'thinking', thinking: 'Need evidence', signature: 'sig-abc' }]
        );
        assert.deepEqual(
            assistantContent.filter((block) => block.type === 'redacted_thinking'),
            [{ type: 'redacted_thinking', data: 'encrypted-redacted' }]
        );

        // Raw provider tool names/arguments never reach the browser; the same
        // sanitized tool_activity contract as every other adapter applies.
        assert.equal(frames.some((frame) => frame.type === 'tool_call'), false);
        const streamedProse = frames
            .filter((frame) => frame.type === 'chunk')
            .map((frame) => frame.content)
            .join('');
        assert.match(streamedProse, /Final customer answer/);
        assert.equal(frames.at(-1).type, 'done');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
