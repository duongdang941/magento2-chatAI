const DEFAULT_IMAGE_PROMPT = 'Mô tả nội dung hình ảnh này và nếu phù hợp hãy tìm sản phẩm tương ứng trong cửa hàng.';
const DEFAULT_IMAGE_DISPLAY_TEXT = 'Đã gửi hình ảnh';
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const IMAGE_PLACEHOLDER_TEXTS = new Set([
    normalizeSearchableText('Sent a product image'),
    normalizeSearchableText('Đã gửi hình ảnh'),
    normalizeSearchableText('Analyze this product image and find matching items in the store.'),
    normalizeSearchableText(DEFAULT_IMAGE_PROMPT)
]);

export function buildUserMessageDescriptor(payload = {}, options = {}) {
    const parts = normalizeIncomingUserParts(payload, options);
    const hasImage = hasImageParts(parts);
    const rawText = normalizeText(payload.text ?? payload.content ?? '');
    const modelText = normalizeText(extractTextFromParts(parts));

    return {
        parts,
        hasImage,
        text: modelText || (hasImage ? normalizeText(options.imagePrompt || DEFAULT_IMAGE_PROMPT) : rawText),
        displayText: rawText && !isImagePlaceholderText(rawText)
            ? rawText
            : (hasImage ? normalizeText(options.imageDisplayText || DEFAULT_IMAGE_DISPLAY_TEXT) : modelText)
    };
}

export function normalizeIncomingUserParts(payload = {}, options = {}) {
    const normalized = [];
    const sourceParts = Array.isArray(payload.parts) ? payload.parts : [];

    for (const part of sourceParts) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        const text = normalizeText(part.text ?? part.raw ?? '');
        if (text) {
            normalized.push({ text });
        }

        const inlineData = extractInlineData(part);
        if (inlineData) {
            normalized.push({ inline_data: inlineData });
        }
    }

    if (!hasImageParts(normalized)) {
        const imageInlineData = extractInlineData(payload.image);
        if (imageInlineData) {
            normalized.push({ inline_data: imageInlineData });
        }
    }

    const rawText = normalizeText(payload.text ?? payload.content ?? '');
    if (hasImageParts(normalized)) {
        const imageParts = normalized.filter((part) => !!extractInlineData(part));
        const usefulTextParts = normalized
            .map((part) => normalizeText(part.text ?? part.raw ?? ''))
            .filter((text) => text && !isImagePlaceholderText(text));
        const usefulRawText = rawText && !isImagePlaceholderText(rawText) ? rawText : '';

        if (usefulTextParts.length === 0) {
            return [
                { text: usefulRawText || normalizeText(options.imagePrompt || DEFAULT_IMAGE_PROMPT) },
                ...imageParts
            ];
        }
    }

    const hasText = normalized.some((part) => normalizeText(part.text || part.raw || '') !== '');
    if (!hasText) {
        if (rawText && !isImagePlaceholderText(rawText)) {
            normalized.unshift({ text: rawText });
        } else if (hasImageParts(normalized)) {
            normalized.unshift({
                text: normalizeText(options.imagePrompt || DEFAULT_IMAGE_PROMPT)
            });
        }
    }

    return normalized;
}

export function extractTextFromParts(parts = []) {
    if (!Array.isArray(parts)) {
        return '';
    }

    return parts
        .map((part) => {
            if (!part || typeof part !== 'object') {
                return '';
            }

            return normalizeText(part.text ?? part.raw ?? '');
        })
        .filter(Boolean)
        .join('\n\n');
}

export function hasImageParts(parts = []) {
    if (!Array.isArray(parts)) {
        return false;
    }

    return parts.some((part) => !!extractInlineData(part));
}

export function validateImageParts(parts = [], options = {}) {
    const maxBytes = Number.isFinite(Number(options.maxBytes))
        ? Math.max(1, Math.trunc(Number(options.maxBytes)))
        : 4 * 1024 * 1024;
    const allowedMimeTypes = options.allowedMimeTypes instanceof Set
        ? options.allowedMimeTypes
        : ALLOWED_IMAGE_MIME_TYPES;
    const maxCount = Number.isFinite(Number(options.maxCount))
        ? Math.max(1, Math.trunc(Number(options.maxCount)))
        : 4;
    let imageCount = 0;

    for (const part of parts) {
        const inlineData = extractInlineData(part);
        if (!inlineData) {
            continue;
        }

        imageCount++;
        if (imageCount > maxCount) {
            return `A message can contain up to ${maxCount} images.`;
        }

        if (!allowedMimeTypes.has(inlineData.mime_type)) {
            return 'Only JPG, PNG, or WebP images are supported.';
        }

        if (!/^[A-Za-z0-9+/=]+$/.test(inlineData.data)) {
            return 'Invalid image payload.';
        }

        if (estimateBase64Bytes(inlineData.data) > maxBytes) {
            return 'Image must be 4MB or smaller.';
        }
    }

    return '';
}

export function toOpenAiContent(parts = [], fallbackText = '') {
    const normalizedParts = [];
    let hasImage = false;
    let hasText = false;

    for (const part of Array.isArray(parts) ? parts : []) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        const text = normalizeText(part.text ?? part.raw ?? '');
        if (text) {
            hasText = true;
            normalizedParts.push({
                type: 'text',
                text
            });
        }

        const inlineData = extractInlineData(part);
        if (inlineData) {
            hasImage = true;
            normalizedParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:${inlineData.mime_type};base64,${inlineData.data}`
                }
            });
        }
    }

    if (!hasImage) {
        const text = normalizeText(extractTextFromParts(parts) || fallbackText);
        return text || '';
    }

    if (!hasText) {
        normalizedParts.unshift({
            type: 'text',
            text: normalizeText(fallbackText) || DEFAULT_IMAGE_PROMPT
        });
    }

    return normalizedParts;
}

export function toGeminiParts(parts = [], fallbackText = '') {
    const normalizedParts = [];
    let hasImage = false;
    let hasText = false;

    for (const part of Array.isArray(parts) ? parts : []) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        const text = normalizeText(part.text ?? part.raw ?? '');
        if (text) {
            hasText = true;
            normalizedParts.push({ text });
        }

        const inlineData = extractInlineData(part);
        if (inlineData) {
            hasImage = true;
            normalizedParts.push({
                inlineData: {
                    mimeType: inlineData.mime_type,
                    data: inlineData.data
                }
            });
        }
    }

    if (!hasImage) {
        const text = normalizeText(extractTextFromParts(parts) || fallbackText);
        return text ? [{ text }] : [];
    }

    if (!hasText) {
        normalizedParts.unshift({
            text: normalizeText(fallbackText) || DEFAULT_IMAGE_PROMPT
        });
    }

    return normalizedParts;
}

function extractInlineData(part) {
    if (!part || typeof part !== 'object') {
        return null;
    }

    const candidate = part.inline_data ?? part.inlineData ?? null;
    if (candidate && typeof candidate === 'object') {
        const mimeType = normalizeText(candidate.mime_type ?? candidate.mimeType ?? '');
        const data = normalizeBase64Data(candidate.data ?? '');
        if (!mimeType || !data) {
            return null;
        }

        return {
            mime_type: mimeType,
            data
        };
    }

    const directMimeType = normalizeText(part.mime_type ?? part.mimeType ?? part.type ?? '');
    const directData = normalizeBase64Data(part.data ?? part.base64 ?? '');
    if (directMimeType.startsWith('image/') && directData) {
        return {
            mime_type: directMimeType,
            data: directData
        };
    }

    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/i);
        if (!match) {
            return null;
        }

        const mimeType = normalizeText(match[1]);
        const data = normalizeBase64Data(match[2]);
        if (!mimeType || !data) {
            return null;
        }

        return {
            mime_type: mimeType,
            data
        };
    }

    return null;
}

function estimateBase64Bytes(data) {
    const clean = normalizeBase64Data(data);
    if (!clean) {
        return 0;
    }

    const padding = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function normalizeBase64Data(value) {
    return String(value || '').replace(/\s+/g, '').trim();
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSearchableText(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9 _-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isImagePlaceholderText(value) {
    const normalized = normalizeSearchableText(value);
    return normalized ? IMAGE_PLACEHOLDER_TEXTS.has(normalized) : false;
}
