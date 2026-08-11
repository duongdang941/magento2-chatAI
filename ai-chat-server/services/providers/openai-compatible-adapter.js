import { streamChatResponse } from '../openai-compatible-orchestrator.js';
import { defineProviderAdapter } from './provider-adapter.js';

export default defineProviderAdapter({
    id: 'openai-compatible',
    protocol: 'openai-chat-completions',
    streamChatResponse
});
