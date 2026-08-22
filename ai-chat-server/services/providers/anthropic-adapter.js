import { streamChatResponse } from '../orchestration/anthropic-orchestrator.js';
import { defineProviderAdapter } from './provider-adapter.js';

export default defineProviderAdapter({
    id: 'anthropic',
    protocol: 'anthropic-messages',
    streamChatResponse
});
