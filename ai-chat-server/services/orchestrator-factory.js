const adapterLoaders = Object.freeze({
    gemini: () => import('./providers/gemini-adapter.js'),
    openai: () => import('./providers/openai-compatible-adapter.js'),
    openrouter: () => import('./providers/openai-compatible-adapter.js'),
    '9router': () => import('./providers/openai-compatible-adapter.js'),
    cockpit: () => import('./providers/openai-compatible-adapter.js')
});

/** Provider selection remains lazy while every implementation obeys one adapter contract. */
export const getProviderAdapter = async (providerName) => {
    const loader = adapterLoaders[String(providerName || '')];
    if (!loader) throw new Error(`Unsupported AI provider: ${providerName}`);
    return (await loader()).default;
};

/** Backward-compatible application boundary used by the chat runner. */
export const getOrchestrator = async (providerName) => (
    await getProviderAdapter(providerName)
).streamChatResponse;
