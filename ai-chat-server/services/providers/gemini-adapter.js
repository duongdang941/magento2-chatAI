import { streamChatResponse } from '../gemini-orchestrator.js';
import { defineProviderAdapter } from './provider-adapter.js';

export default defineProviderAdapter({
    id: 'gemini',
    protocol: 'google-generative-ai',
    streamChatResponse
});
