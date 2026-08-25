import { resolveImageTransport } from '../media/image-transport.js';

/**
 * The commerce agent is provider-neutral. This registry deliberately models
 * only protocols that the gateway implements, not a provider marketing claim
 * or the availability/quota of an arbitrary model on a merchant account.
 */
const PROFILES = Object.freeze({
    gemini: Object.freeze({
        imageGeneration: true,
        voiceDictation: true,
        liveVoice: false,
        nativeWebGrounding: true
    }),
    openai: Object.freeze({
        imageGeneration: true,
        voiceDictation: true,
        liveVoice: true,
        nativeWebGrounding: false
    }),
    openrouter: Object.freeze({
        imageGeneration: true,
        voiceDictation: true,
        liveVoice: false,
        nativeWebGrounding: false
    }),
    '9router': Object.freeze({
        imageGeneration: true,
        voiceDictation: true,
        liveVoice: false,
        nativeWebGrounding: false
    }),
    cockpit: Object.freeze({
        imageGeneration: true,
        voiceDictation: true,
        liveVoice: false,
        nativeWebGrounding: false
    })
});

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function enabled(value, fallback = false) {
    return value === undefined ? fallback : value === true || value === 1 || value === '1' || value === 'true';
}

function capability(supported, configured, unavailableReason) {
    return Object.freeze({
        supported: Boolean(supported),
        available: Boolean(supported && configured),
        reason: supported && configured ? '' : unavailableReason
    });
}

function selectedModelAllowsImageGeneration(config = {}) {
    const models = Array.isArray(config.models) ? config.models : [];
    const selected = models.find((model) => text(model?.id) === text(config.model));
    if (!selected) return true;

    const capabilities = selected.capabilities && typeof selected.capabilities === 'object'
        ? selected.capabilities
        : {};
    const declared = capabilities.image_generation ?? capabilities.create_edit_image;
    // Older rows stored supports_images from a global switch. It is not an
    // explicit per-model decision, therefore only the new contract can opt
    // the model out of Image.
    return declared === undefined ? true : enabled(declared, true);
}

export function normalizeProvider(provider) {
    const normalized = text(provider).toLowerCase();
    return normalized || 'custom';
}

function protocolForConfig(config = {}) {
    const format = String(config.api_format || '').trim().toLowerCase();
    if (format === 'anthropic-messages') return 'anthropic';
    if (format === 'openai-responses') return 'openai';
    if (format === 'openai-chat-completions') return 'openai-compatible';
    return normalizeProvider(config.provider);
}

/**
 * Return browser-safe capability metadata. API keys and base URLs are never
 * exposed here; the result can safely be returned by the internal config-sync
 * endpoint and used for observability.
 */
export function getProviderCapabilities(config = {}) {
    const provider = normalizeProvider(config.provider);
    const protocol = protocolForConfig(config);
    const profile = PROFILES[provider] || PROFILES[protocol] || (
        protocol === 'anthropic' || protocol === 'openai-compatible' || protocol === 'openai'
            // Chat protocol alone does not determine an image API. A custom
            // provider may expose a documented, separate image route; the
            // selected model's image transport below is the actual gate.
            ? { imageGeneration: true, voiceDictation: true, liveVoice: false, nativeWebGrounding: false }
            : null
    );
    const hasApiKey = text(config.api_key) !== '';
    const image = config.image_generation && typeof config.image_generation === 'object'
        ? config.image_generation
        : {};
    const voice = config.voice && typeof config.voice === 'object' ? config.voice : {};
    const liveVoice = voice.live && typeof voice.live === 'object' ? voice.live : {};

    const providerSupported = Boolean(profile);
    const chat = capability(
        providerSupported,
        hasApiKey,
        providerSupported ? 'provider_api_key_missing' : 'provider_unsupported'
    );
    const selectedModelAllowsImages = selectedModelAllowsImageGeneration(config);
    const imageEnabled = enabled(image.enabled, true) && selectedModelAllowsImages;
    const imageTransport = resolveImageTransport(config);
    const imageModelReady = imageTransport === 'openai-responses' || text(image.model) !== '';
    const voiceEnabled = enabled(voice.enabled, true);
    const liveEnabled = enabled(liveVoice.enabled, false);

    const nativeImageApiSupported = Boolean(profile?.imageGeneration) && imageTransport !== '';
    // A checked model capability is also usable without a native image API:
    // the existing generateImage flow requests a safe, self-contained SVG
    // from the chat model.  Do not hide the feature merely because a custom
    // provider only exposes its chat endpoint.
    const imageGenerationAvailable = Boolean(profile?.imageGeneration)
        && imageEnabled
        && hasApiKey
        && (!imageTransport || imageModelReady);
    const imageGenerationReason = !profile?.imageGeneration
        ? 'provider_image_generation_unsupported'
        : !selectedModelAllowsImages
            ? 'model_image_generation_unsupported'
            : !imageEnabled
                ? 'image_generation_disabled'
                : !hasApiKey
                    ? 'provider_api_key_missing'
                    : imageTransport && !imageModelReady
                        ? 'image_model_missing'
                        : '';
    const imageGeneration = Object.freeze({
        supported: nativeImageApiSupported,
        available: imageGenerationAvailable,
        reason: imageGenerationAvailable ? '' : imageGenerationReason
    });

    return Object.freeze({
        contract_version: 1,
        provider: provider || text(config.provider).toLowerCase(),
        protocol,
        chat,
        streaming: capability(providerSupported, hasApiKey, chat.reason),
        commerce_tools: capability(providerSupported, hasApiKey, chat.reason),
        image_generation: imageGeneration,
        // The model editor already records the future-facing video flag, but
        // there is no video transport/tool implementation yet. Never expose a
        // non-functional customer control merely because a model was prepared
        // for that later capability.
        video_generation: capability(false, false, 'video_generation_not_implemented'),
        voice_dictation: capability(
            Boolean(profile?.voiceDictation),
            voiceEnabled && hasApiKey && text(voice.transcription_model) !== '',
            !profile?.voiceDictation
                ? 'provider_voice_dictation_unsupported'
                : !voiceEnabled
                    ? 'voice_dictation_disabled'
                    : !hasApiKey
                        ? 'provider_api_key_missing'
                        : 'voice_model_missing'
        ),
        live_voice: capability(
            Boolean(profile?.liveVoice),
            liveEnabled && text(liveVoice.api_key) !== '' && text(liveVoice.model) !== '',
            !profile?.liveVoice
                ? 'provider_live_voice_unsupported'
                : !liveEnabled
                    ? 'live_voice_disabled'
                    : text(liveVoice.api_key) === ''
                        ? 'live_voice_api_key_missing'
                        : 'live_voice_model_missing'
        ),
        native_web_grounding: capability(
            Boolean(profile?.nativeWebGrounding),
            hasApiKey && text(config.grounding_model) !== '',
            !profile?.nativeWebGrounding
                ? 'provider_native_web_grounding_unsupported'
                : !hasApiKey
                    ? 'provider_api_key_missing'
                    : 'grounding_model_missing'
        )
    });
}

/**
 * Validate only structural conditions known locally. Model entitlement and
 * quota remain runtime concerns and must not make Magento Admin claims that
 * cannot be verified without charging the provider API.
 */
export function validateProviderConfiguration(config = {}, scope = 'default') {
    const capabilities = getProviderCapabilities(config);
    const errors = [];
    const warnings = [];

    if (!normalizeProvider(config.provider) || !capabilities.protocol) {
        errors.push({ scope, code: 'provider_unsupported', message: 'Select a supported AI provider.' });
    } else if (enabled(config.enabled, true) && !capabilities.chat.available) {
        errors.push({
            scope,
            code: capabilities.chat.reason,
            message: 'The enabled Store Assistant requires an API key for its selected provider.'
        });
    }

    if (enabled(config.enabled, true)
        && enabled(config.image_generation?.enabled, true)
        && !capabilities.image_generation.available) {
        warnings.push({
            scope,
            code: capabilities.image_generation.reason,
            message: 'Image generation is enabled but is not ready for the selected provider configuration.'
        });
    }
    if (enabled(config.enabled, true)
        && enabled(config.voice?.enabled, true)
        && !capabilities.voice_dictation.available) {
        warnings.push({
            scope,
            code: capabilities.voice_dictation.reason,
            message: 'Voice dictation is enabled but is not ready for the selected provider configuration.'
        });
    }
    return { capabilities, errors, warnings };
}
