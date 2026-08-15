import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getProviderCapabilities } from '../providers/provider-capabilities.js';

const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_IMAGE_SIZE = '1024x1024';
const DEFAULT_IMAGE_QUALITY = 'medium';
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const IMAGE_QUALITIES = new Set(['low', 'medium', 'high']);

function readString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(value) {
    return readString(value).replace(/\/+$/, '');
}

function resolveImageProviderConfig(config = {}) {
    const provider = readString(config.provider, 'cockpit');
    const capabilities = getProviderCapabilities(config);
    if (!capabilities.image_generation.supported) {
        throw new Error('Image generation is not available through the selected provider.');
    }

    const imageConfig = config.image_generation && typeof config.image_generation === 'object'
        ? config.image_generation
        : {};
    const envPrefix = provider === 'cockpit'
        ? 'COCKPIT'
        : provider === 'openai'
            ? 'OPENAI'
            : provider === 'openrouter'
                ? 'OPENROUTER'
                : provider === '9router' ? 'NINE_ROUTER' : 'GEMINI';
    const defaultBaseUrl = provider === 'cockpit'
        ? 'http://127.0.0.1:49998/v1'
        : provider === 'openai'
            ? 'https://api.openai.com/v1'
            : provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : provider === '9router'
                    ? 'https://raud4eq.9router.com/v1'
                    : (process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta');
    const apiKey = readString(config.api_key, process.env[`${envPrefix}_API_KEY`] || '');
    const baseUrl = normalizeBaseUrl(
        config.base_url || process.env[`${envPrefix}_BASE_URL`] || defaultBaseUrl
    );
    let model = readString(
        imageConfig.model,
        process.env[`${envPrefix}_IMAGE_MODEL`] || (provider === 'gemini' ? DEFAULT_GEMINI_IMAGE_MODEL : DEFAULT_IMAGE_MODEL)
    );
    if (provider === 'gemini' && /^gpt[-_]/i.test(model)) model = DEFAULT_GEMINI_IMAGE_MODEL;
    const requestedSize = readString(
        imageConfig.size,
        readString(process.env[`${envPrefix}_IMAGE_SIZE`], DEFAULT_IMAGE_SIZE)
    );
    const requestedQuality = readString(
        imageConfig.quality,
        readString(process.env[`${envPrefix}_IMAGE_QUALITY`], DEFAULT_IMAGE_QUALITY)
    );
    const size = IMAGE_SIZES.has(requestedSize) ? requestedSize : DEFAULT_IMAGE_SIZE;
    const quality = IMAGE_QUALITIES.has(requestedQuality) ? requestedQuality : DEFAULT_IMAGE_QUALITY;

    if (!apiKey) throw new Error('The selected image provider API key is missing.');
    if (!baseUrl) throw new Error('The selected image provider base URL is missing.');

    return { provider, apiKey, baseUrl, model, size, quality };
}

function buildAbortController(parentSignal, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        const error = new Error('Image generation timed out.');
        error.code = 'IMAGE_GENERATION_TIMEOUT';
        controller.abort(error);
    }, timeoutMs);
    const forwardAbort = () => controller.abort(parentSignal?.reason);

    if (parentSignal) {
        if (parentSignal.aborted) forwardAbort();
        else parentSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', forwardAbort);
        }
    };
}

async function readProviderError(response) {
    const raw = await response.text();
    let message = raw;
    try {
        const parsed = JSON.parse(raw);
        message = parsed.error?.message || parsed.message || raw;
    } catch {}

    const error = new Error(message || `Image provider returned HTTP ${response.status}`);
    error.status = response.status;
    return error;
}

function decodeImageData(image, outputFormat = 'png') {
    const base64 = String(image?.b64_json || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    if (!base64) return null;

    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > DEFAULT_MAX_IMAGE_BYTES) {
        throw new Error('Generated image is too large to display.');
    }

    const format = readString(outputFormat, 'png').toLowerCase();
    const mimeType = format === 'jpeg' || format === 'jpg'
        ? 'image/jpeg'
        : format === 'webp' ? 'image/webp' : 'image/png';
    const extension = format === 'jpeg' || format === 'jpg' ? 'jpg' : format;

    return { bytes, mimeType, extension };
}

function generatedImageDirectory() {
    return process.env.AI_GENERATED_IMAGE_DIRECTORY
        || path.resolve(new URL('.', import.meta.url).pathname, '../../../../../../pub/media/afd-ai/generated');
}

function generatedImagePublicBaseUrl(config = {}) {
    return normalizeBaseUrl(
        process.env.AI_GENERATED_IMAGE_PUBLIC_BASE_URL
        || process.env.MAGENTO_PUBLIC_BASE_URL
        || config.magento_base_url
        || process.env.MAGENTO_API_URL
        || ''
    );
}

async function persistGeneratedImage(image, outputFormat, config = {}) {
    const decoded = decodeImageData(image, outputFormat);
    if (!decoded) return null;

    const directory = generatedImageDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o750 });
    const filename = `${Date.now()}-${crypto.randomUUID()}.${decoded.extension}`;
    const filePath = path.join(directory, filename);
    await fs.writeFile(filePath, decoded.bytes, { mode: 0o640 });

    return {
        url: `${generatedImagePublicBaseUrl(config)}/media/afd-ai/generated/${filename}`,
        mime_type: decoded.mimeType,
        filename
    };
}

export function buildImageGenerationRequest(prompt, config = {}) {
    const providerConfig = resolveImageProviderConfig(config);
    const body = providerConfig.provider === 'gemini'
        ? {
            contents: [{ role: 'user', parts: [{ text: String(prompt || '').trim().slice(0, 4000) }] }],
            generationConfig: {
                responseModalities: ['IMAGE'],
                responseFormat: {
                    image: {
                        aspectRatio: geminiAspectRatioFromSize(providerConfig.size),
                        imageSize: 'IMAGE_SIZE_1K'
                    }
                }
            }
        }
        : {
            model: providerConfig.model,
            prompt: String(prompt || '').trim().slice(0, 4000),
            size: providerConfig.size,
            quality: providerConfig.quality,
            output_format: 'png'
        };
    return {
        ...providerConfig,
        body
    };
}

function geminiAspectRatioFromSize(size) {
    if (size === '1536x1024') return 'ASPECT_RATIO_3_2';
    if (size === '1024x1536') return 'ASPECT_RATIO_2_3';
    return 'ASPECT_RATIO_1_1';
}

function geminiImageUrl(baseUrl, model) {
    const endpoint = normalizeBaseUrl(baseUrl);
    const safeModel = encodeURIComponent(String(model || '').trim());
    return /\/models$/i.test(endpoint)
        ? `${endpoint}/${safeModel}:generateContent`
        : `${endpoint}/models/${safeModel}:generateContent`;
}

export async function generateImage({ prompt, ws, config = {}, signal = null, isCancelled = () => false } = {}) {
    const cleanPrompt = String(prompt || '').trim().slice(0, 4000);
    if (!cleanPrompt) throw new Error('Please describe the image you want to create.');
    if (config.image_generation?.enabled === false) {
        throw new Error('Image generation is disabled in Magento Admin.');
    }

    const request = buildImageGenerationRequest(cleanPrompt, config);
    const imageId = `image-${crypto.randomUUID()}`;
    ws?.send?.(JSON.stringify({
        type: 'image_generation_started',
        image_id: imageId,
        started_at: Date.now(),
        prompt: cleanPrompt,
        size: request.size,
        quality: request.quality
    }));

    const providerSignal = buildAbortController(
        signal,
        Math.max(
            30000,
            Math.min(
                Number(config.image_generation?.timeout_ms)
                    || Number(process.env.AI_IMAGE_GENERATION_TIMEOUT_MS)
                    || 180000,
                300000
            )
        )
    );
    try {
        const response = await fetch(
                request.provider === 'gemini'
                ? geminiImageUrl(request.baseUrl, request.model)
                : `${request.baseUrl}/images/generations`, {
            method: 'POST',
            headers: {
                ...(request.provider === 'gemini'
                    ? { 'x-goog-api-key': request.apiKey }
                    : { Authorization: `Bearer ${request.apiKey}` }),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(request.body),
            signal: providerSignal.signal
        });

        if (!response.ok) throw await readProviderError(response);
        const payload = await response.json();
        if (isCancelled()) return { cancelled: true };

        const firstImage = request.provider === 'gemini'
            ? extractGeminiImage(payload)
            : (Array.isArray(payload.data) ? payload.data[0] : null);
        const stored = await persistGeneratedImage(firstImage, request.provider === 'gemini' ? 'png' : (payload.output_format || 'png'), config);
        if (!stored) throw new Error('The image provider returned no image data.');

        const result = {
            image_id: imageId,
            url: stored.url,
            mime_type: stored.mime_type,
            alt: cleanPrompt,
            revised_prompt: String(firstImage?.revised_prompt || '').slice(0, 4000),
            size: payload.size || request.size,
            quality: payload.quality || request.quality
        };
        ws?.send?.(JSON.stringify({ type: 'image_generated', ...result }));
        return result;
    } catch (error) {
        if (!isCancelled()) {
            ws?.send?.(JSON.stringify({
                type: 'image_generation_failed',
                image_id: imageId,
                message: error.message || 'Image generation failed.'
            }));
        }
        throw error;
    } finally {
        providerSignal.dispose();
    }
}

function extractGeminiImage(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts;
    const inlineData = Array.isArray(parts) ? parts.find((part) => part?.inlineData?.data)?.inlineData : null;
    return inlineData ? { b64_json: inlineData.data } : null;
}
