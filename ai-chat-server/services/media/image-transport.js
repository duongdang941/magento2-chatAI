const IMAGE_TRANSPORTS = new Set([
    'openai-images',
    'openai-responses',
    'gemini-generate-content'
]);

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Image creation is a separate API contract from chat streaming.  A provider
 * can therefore use an Anthropic-compatible endpoint for chat while exposing
 * no image endpoint at all.  Keep this resolver intentionally data-driven:
 * the selected model metadata is the authority for a custom provider.
 */
export function normalizeImageTransport(value) {
    const transport = text(value).toLowerCase();
    return IMAGE_TRANSPORTS.has(transport) ? transport : '';
}

export function selectedModel(config = {}) {
    const models = Array.isArray(config.models) ? config.models : [];
    return models.find((model) => text(model?.id) === text(config.model)) || null;
}

export function defaultImageTransport(config = {}) {
    const baseUrl = text(config.base_url).toLowerCase();
    const apiFormat = text(config.api_format).toLowerCase();
    let hostname = '';
    try {
        hostname = new URL(baseUrl).hostname.toLowerCase();
    } catch {}

    // Backward compatibility is limited to official/native endpoints.  A
    // custom tunnel must opt in explicitly through its model metadata.
    if (apiFormat === 'openai-responses') return 'openai-responses';
    if (['openai', 'cockpit', 'openrouter', '9router'].includes(config.provider)) return 'openai-images';
    if (config.provider === 'gemini' && (!baseUrl || hostname === 'generativelanguage.googleapis.com')) {
        return 'gemini-generate-content';
    }
    return '';
}

export function resolveImageTransport(config = {}) {
    const image = config.image_generation && typeof config.image_generation === 'object'
        ? config.image_generation
        : {};
    if (Object.prototype.hasOwnProperty.call(image, 'transport')) {
        return normalizeImageTransport(image.transport);
    }
    const model = selectedModel(config);
    const explicit = normalizeImageTransport(image.transport)
        || normalizeImageTransport(model?.image_transport)
        || normalizeImageTransport(model?.image_generation?.transport);

    if (model) {
        return model.supports_images === true && explicit ? explicit : '';
    }

    // Older installations without a Magento provider registry retain only
    // well-known native contracts, never a name-based custom-provider guess.
    return explicit || defaultImageTransport(config);
}

export function imageTransportLabel(transport) {
    switch (normalizeImageTransport(transport)) {
        case 'openai-images':
            return 'OpenAI Images API';
        case 'openai-responses':
            return 'OpenAI Responses image-generation tool';
        case 'gemini-generate-content':
            return 'Gemini generateContent API';
        default:
            return 'No image API';
    }
}
