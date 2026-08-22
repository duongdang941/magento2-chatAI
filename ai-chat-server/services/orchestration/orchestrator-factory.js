import { createCircuitOpenError, ProviderCircuitBreaker } from '../providers/provider-circuit-breaker.js';

const adapterLoaders = Object.freeze({
    gemini: () => import('../providers/gemini-adapter.js'),
    anthropic: () => import('../providers/anthropic-adapter.js'),
    'anthropic-messages': () => import('../providers/anthropic-adapter.js'),
    openai: () => import('../providers/openai-compatible-adapter.js'),
    'openai-chat-completions': () => import('../providers/openai-compatible-adapter.js'),
    'openai-responses': () => import('../providers/openai-compatible-adapter.js'),
    openrouter: () => import('../providers/openai-compatible-adapter.js'),
    '9router': () => import('../providers/openai-compatible-adapter.js'),
    cockpit: () => import('../providers/openai-compatible-adapter.js')
});

const providerCircuitBreaker = new ProviderCircuitBreaker();

function providerKey(providerName, config = {}) {
    return [
        String(providerName || config.provider || 'provider').toLowerCase(),
        String(config.api_format || ''),
        String(config.base_url || ''),
        String(config.model || '')
    ].join('|');
}

/** Provider selection resolves dynamically based on provider name or API format */
export const getProviderAdapter = async (providerName, config = {}) => {
    const format = String(config.api_format || '').toLowerCase();
    if (format === 'anthropic-messages' || format === 'anthropic') {
        return (await adapterLoaders['anthropic']()).default;
    }

    const providerKey = String(providerName || '').toLowerCase();
    const loader = adapterLoaders[providerKey] || adapterLoaders[format] || adapterLoaders['openai'];
    return (await loader()).default;
};

/** Backward-compatible application boundary used by the chat runner. */
export const getOrchestrator = async (providerName, config = {}) => {
    const adapter = await getProviderAdapter(providerName, config);
    const key = providerKey(providerName, config);

    return async (...args) => {
        const admission = providerCircuitBreaker.beforeRequest(key);
        if (!admission.allowed) {
            const error = createCircuitOpenError(admission.retryAfterMs);
            args[1]?.send?.(JSON.stringify({
                type: 'error',
                error_code: error.code,
                recoverable: true,
                retry_after: Math.ceil(error.retryAfterMs / 1000),
                content: 'The AI provider is temporarily unavailable. Please try again shortly.'
            }));
            return { cancelled: false, error };
        }

        const result = await adapter.streamChatResponse(...args);
        if (result?.error) {
            providerCircuitBreaker.recordFailure(key);
        } else if (!result?.cancelled) {
            providerCircuitBreaker.recordSuccess(key);
        }
        return result;
    };
};

export function getProviderCircuitHealth() {
    return providerCircuitBreaker.snapshot();
}
