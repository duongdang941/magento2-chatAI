import test from 'node:test';
import assert from 'node:assert/strict';

import { defineProviderAdapter } from '../services/providers/provider-adapter.js';

test('enforces the provider adapter contract', () => {
    const streamChatResponse = async () => {};
    const adapter = defineProviderAdapter({ id: 'test', protocol: 'test', streamChatResponse });
    assert.equal(adapter.streamChatResponse, streamChatResponse);
    assert.throws(() => defineProviderAdapter({ id: 'broken' }), /requires/);
});
