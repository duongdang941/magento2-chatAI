import fs from 'node:fs';
import path from 'node:path';

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

        const attachmentRef = extractAttachmentRef(part);
        if (attachmentRef) {
            normalized.push(attachmentRef);
            continue;
        }

        const inlineData = extractInlineData(part);
        if (inlineData) {
            normalized.push({ inline_data: inlineData });
        }
    }

    if (!hasImageParts(normalized)) {
        const payloadAttachmentRef = extractAttachmentRef(payload.attachment || payload.attachment_ref || payload);
        if (payloadAttachmentRef) {
            normalized.push(payloadAttachmentRef);
        } else {
            const imageInlineData = extractInlineData(payload.image);
            if (imageInlineData) {
                normalized.push({ inline_data: imageInlineData });
            }
        }
    }

    const rawText = normalizeText(payload.text ?? payload.content ?? '');
    if (hasImageParts(normalized)) {
        const imageParts = normalized.filter((part) => !!extractInlineData(part) || !!extractAttachmentRef(part));
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

    return parts.some((part) => !!extractInlineData(part) || !!extractAttachmentRef(part));
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
    const maxTotalBytes = Number.isFinite(Number(options.maxTotalBytes))
        ? Math.max(1, Math.trunc(Number(options.maxTotalBytes)))
        : 6 * 1024 * 1024;
    const maxEncodedBytes = Number.isFinite(Number(options.maxEncodedBytes))
        ? Math.max(1, Math.trunc(Number(options.maxEncodedBytes)))
        : 6 * 1024 * 1024;
    let imageCount = 0;
    let totalBytes = 0;
    let totalEncodedBytes = 0;

    for (const part of parts) {
        const attachmentRef = extractAttachmentRef(part);
        if (attachmentRef) {
            imageCount++;
            if (imageCount > maxCount) {
                return `A message can contain up to ${maxCount} images.`;
            }
            if (attachmentRef.mime_type && !allowedMimeTypes.has(attachmentRef.mime_type)) {
                return 'Only JPG, PNG, or WebP images are supported.';
            }
            if (attachmentRef.bytes > maxBytes) {
                return 'Image must be 4MB or smaller.';
            }
            totalBytes += attachmentRef.bytes;
            if (totalBytes > maxTotalBytes) {
                return 'The combined image upload is too large. Remove an image or choose smaller files.';
            }
            continue;
        }

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

        const imageBytes = estimateBase64Bytes(inlineData.data);
        if (imageBytes > maxBytes) {
            return 'Image must be 4MB or smaller.';
        }
        totalBytes += imageBytes;
        totalEncodedBytes += typeof Buffer !== 'undefined'
            ? Buffer.byteLength(inlineData.data, 'utf8')
            : inlineData.data.length;
        if (totalBytes > maxTotalBytes || totalEncodedBytes > maxEncodedBytes) {
            return 'The combined image upload is too large. Remove an image or choose smaller files.';
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

        const attachmentRef = extractAttachmentRef(part);
        if (attachmentRef) {
            hasImage = true;
            if (attachmentRef.url) {
                normalizedParts.push({
                    type: 'image_url',
                    image_url: { url: attachmentRef.url }
                });
            } else if (attachmentRef.attachment_id) {
                const localData = resolveLocalAttachmentData(attachmentRef.attachment_id);
                if (localData) {
                    normalizedParts.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${localData.mimeType};base64,${localData.data}`
                        }
                    });
                }
            }
            continue;
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

        const attachmentRef = extractAttachmentRef(part);
        if (attachmentRef) {
            hasImage = true;
            if (attachmentRef.attachment_id) {
                const localData = resolveLocalAttachmentData(attachmentRef.attachment_id);
                if (localData) {
                    normalizedParts.push({
                        inlineData: {
                            mimeType: localData.mimeType,
                            data: localData.data
                        }
                    });
                }
            }
            continue;
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

export function extractAttachmentRef(part) {
    if (!part || typeof part !== 'object') {
        return null;
    }

    if (part.type === 'attachment_ref' && (part.attachment_id || part.attachmentId)) {
        return {
            type: 'attachment_ref',
            attachment_id: String(part.attachment_id || part.attachmentId),
            kind: part.kind || 'image',
            purpose: part.purpose || 'vision',
            mime_type: part.mime_type || part.mimeType || 'image/jpeg',
            bytes: Number(part.bytes || part.size) || 0,
            url: typeof part.url === 'string' ? part.url : ''
        };
    }

    if ((part.attachment_id || part.attachmentId) && !extractInlineData(part)) {
        return {
            type: 'attachment_ref',
            attachment_id: String(part.attachment_id || part.attachmentId),
            kind: part.kind || 'image',
            purpose: part.purpose || 'vision',
            mime_type: part.mime_type || part.mimeType || 'image/jpeg',
            bytes: Number(part.bytes || part.size) || 0,
            url: typeof part.url === 'string' ? part.url : ''
        };
    }

    return null;
}

export function resolveLocalAttachmentData(attachmentId, ownerPath = null) {
    if (!attachmentId || typeof attachmentId !== 'string' || !/^att_[a-f0-9]{32}$/.test(attachmentId)) {
        return null;
    }

    const varChatDir = path.resolve(process.cwd(), '../../../../var/afd_ai/chat');
    if (!fs.existsSync(varChatDir)) {
        return null;
    }

    const exts = ['jpg', 'png', 'webp'];
    if (ownerPath) {
        for (const ext of exts) {
            const directPath = path.join(varChatDir, ownerPath, 'staged', `${attachmentId}.${ext}`);
            if (fs.existsSync(directPath)) {
                return readAttachmentFileBounded(directPath, ext);
            }
        }
    }

    try {
        const ownerDirs = fs.readdirSync(varChatDir);
        for (const ownerDir of ownerDirs) {
            for (const ext of exts) {
                const target = path.join(varChatDir, ownerDir, 'staged', `${attachmentId}.${ext}`);
                if (fs.existsSync(target)) {
                    return readAttachmentFileBounded(target, ext);
                }
                const guestTarget = path.join(varChatDir, 'guest', ownerDir, 'staged', `${attachmentId}.${ext}`);
                if (fs.existsSync(guestTarget)) {
                    return readAttachmentFileBounded(guestTarget, ext);
                }
            }
        }
    } catch {
        return null;
    }

    return null;
}

function readAttachmentFileBounded(filePath, ext) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > 5 * 1024 * 1024) {
            return null;
        }
        const mimeType = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        const buffer = fs.readFileSync(filePath);
        return {
            mimeType,
            data: buffer.toString('base64'),
            bytes: stat.size
        };
    } catch {
        return null;
    }
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

export function recordOutboundAssistantPart(assistantParts, parsed) {
    if (!Array.isArray(assistantParts) || !parsed || typeof parsed !== 'object') return;

    if (parsed.type === 'chunk' && parsed.content) {
        const lastPart = assistantParts[assistantParts.length - 1];
        if (lastPart && lastPart.type === 'text') {
            lastPart.raw += parsed.content;
        } else {
            assistantParts.push({ type: 'text', raw: parsed.content });
        }
    } else if (parsed.type === 'discard_thinking_text') {
        discardLatestThinkingText(assistantParts);
    } else if (parsed.type === 'products_html' && parsed.html) {
        const incomingPart = {
            type: 'products',
            html: parsed.html,
            payload: parsed.products && typeof parsed.products === 'object' ? parsed.products : null
        };
        const existingIndex = findLastProductPartIndex(assistantParts);
        if (existingIndex >= 0) {
            assistantParts.splice(existingIndex, 1, incomingPart);
        } else {
            assistantParts.push(incomingPart);
        }
    } else if (parsed.type === 'image_generated' && parsed.url) {
        assistantParts.push({
            type: 'image',
            url: String(parsed.url),
            alt: String(parsed.alt || 'Generated image'),
            prompt: String(parsed.alt || '').slice(0, 4000),
            size: String(parsed.size || ''),
            quality: String(parsed.quality || '')
        });
    } else if (parsed.type === 'guest_order_access_required') {
        assistantParts.push({
            type: 'guest_order_access',
            state: 'email',
            purpose: parsed.purpose === 'support' ? 'support' : 'order',
            expires_at: parsed.expires_at
        });
    } else if (parsed.type === 'thinking_delta') {
        let reasoningPart = assistantParts.find(p => p.type === 'reasoning');
        if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', events: [], steps: [], activities: [] };
            assistantParts.unshift(reasoningPart);
        }
        if (!Array.isArray(reasoningPart.events)) reasoningPart.events = [];
        const stepId = String(parsed.step_id || 'step-active');
        let stepItem = reasoningPart.events.find(e => e.type === 'step' && e.id === stepId);
        if (!stepItem) {
            stepItem = {
                id: stepId,
                type: 'step',
                content: ''
            };
            reasoningPart.events.push(stepItem);
        }
        stepItem.content += String(parsed.delta || '');
    } else if (parsed.type === 'discard_tentative_step') {
        let reasoningPart = assistantParts.find(p => p.type === 'reasoning');
        if (reasoningPart && Array.isArray(reasoningPart.events)) {
            const stepId = String(parsed.step_id || '');
            if (stepId) {
                reasoningPart.events = reasoningPart.events.filter(e => e.id !== stepId);
            }
        }
    } else if (parsed.type === 'thinking_step' && parsed.content) {
        let reasoningPart = assistantParts.find(p => p.type === 'reasoning');
        if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', events: [], steps: [], activities: [] };
            assistantParts.unshift(reasoningPart);
        }
        if (!Array.isArray(reasoningPart.events)) reasoningPart.events = [];
        const stepId = String(parsed.step_id || 'step-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
        const existing = reasoningPart.events.find(e => e.type === 'step' && e.id === stepId);
        if (existing) {
            existing.content = String(parsed.content);
        } else {
            const stepItem = {
                id: stepId,
                type: 'step',
                content: String(parsed.content),
                tool: String(parsed.tool || '')
            };
            reasoningPart.events.push(stepItem);
            if (Array.isArray(reasoningPart.steps)) reasoningPart.steps.push(stepItem);
        }
    } else if (parsed.type === 'tool_activity' && parsed.tool) {
        let reasoningPart = assistantParts.find(p => p.type === 'reasoning');
        if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', events: [], steps: [], activities: [] };
            assistantParts.unshift(reasoningPart);
        }
        if (!Array.isArray(reasoningPart.events)) reasoningPart.events = [];
        const activityId = String(parsed.activity_id || '');
        const existing = reasoningPart.events.find(a => a.type === 'activity' && a.id === activityId);
        if (existing) {
            existing.state = parsed.state;
            if (parsed.result_count !== undefined) existing.result_count = parsed.result_count;
        } else {
            const actItem = {
                id: activityId,
                type: 'activity',
                tool: String(parsed.tool || ''),
                state: String(parsed.state || 'running'),
                result_count: parsed.result_count
            };
            reasoningPart.events.push(actItem);
            if (Array.isArray(reasoningPart.activities)) reasoningPart.activities.push(actItem);
        }
    }
}

export function discardLatestThinkingText(parts) {
    if (!Array.isArray(parts)) return;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index]?.type === 'text') {
            parts.splice(index, 1);
            return;
        }
        if (parts[index]?.type === 'products') {
            return;
        }
    }
}

function findLastProductPartIndex(parts) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index]?.type === 'products') return index;
    }
    return -1;
}
