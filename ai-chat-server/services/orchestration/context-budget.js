const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Provider-neutral token estimate used only for deterministic context budgets.
 * Exact billing remains provider-specific; UTF-8 bytes are also returned by
 * every benchmark/telemetry record so the estimate is never presented as an
 * invoice value.
 */
export function estimateContextTokens(value, bytesPerToken = DEFAULT_BYTES_PER_TOKEN) {
    const bytes = contextBytes(value);
    return Math.max(0, Math.ceil(bytes / Math.max(1, Number(bytesPerToken) || DEFAULT_BYTES_PER_TOKEN)));
}

export function contextBytes(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return Buffer.byteLength(text, 'utf8');
}

/**
 * Keep the newest conversation evidence within both a message limit and a
 * byte-derived token budget. One oversized message is compacted with its head
 * and tail intact instead of being sliced at an arbitrary 4,000 characters.
 */
export function fitHistoryToBudget(history, options = {}) {
    if (!Array.isArray(history)) return [];

    const maxMessages = clampInteger(options.maxMessages, 20, 1, 40);
    // Public configuration starts at 512. The lower internal floor lets a
    // caller reserve part of that budget for structured commerce memory.
    const maxTokens = clampInteger(options.maxTokens, 12000, 64, 64000);
    const budgetBytes = maxTokens * DEFAULT_BYTES_PER_TOKEN;
    const candidates = history.filter((message) => message && typeof message === 'object').slice(-maxMessages);
    const selected = [];
    let usedBytes = 0;

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const message = candidates[index];
        const bytes = contextBytes(message);
        if (usedBytes + bytes <= budgetBytes) {
            selected.unshift(message);
            usedBytes += bytes;
            continue;
        }

        const remaining = budgetBytes - usedBytes;
        if (selected.length === 0 && remaining > 128) {
            const compacted = compactHistoryMessage(message, remaining);
            if (compacted) selected.unshift(compacted);
        }
        break;
    }

    return selected;
}

function compactHistoryMessage(message, maxBytes) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts.map((part) => String(part?.text || '')).filter(Boolean).join('\n\n');
    if (!text) return null;

    const role = message.role;
    const shellBytes = contextBytes({ role, parts: [{ text: '' }] });
    const available = Math.max(0, maxBytes - shellBytes);
    if (available < 64) return null;

    return {
        role,
        parts: [{ text: truncateUtf8Middle(text, available) }]
    };
}

export function truncateUtf8Middle(value, maxBytes) {
    const text = String(value || '');
    if (contextBytes(text) <= maxBytes) return text;

    const marker = '\n[… older context compacted …]\n';
    const markerBytes = contextBytes(marker);
    if (maxBytes <= markerBytes + 8) return truncateUtf8End(text, maxBytes);

    const contentBudget = maxBytes - markerBytes;
    const headBudget = Math.floor(contentBudget * 0.7);
    const tailBudget = contentBudget - headBudget;
    return `${truncateUtf8End(text, headBudget)}${marker}${truncateUtf8Start(text, tailBudget)}`;
}

function truncateUtf8End(value, maxBytes) {
    let result = '';
    for (const character of String(value || '')) {
        if (contextBytes(result + character) > maxBytes) break;
        result += character;
    }
    return result;
}

function truncateUtf8Start(value, maxBytes) {
    const characters = Array.from(String(value || ''));
    let result = '';
    for (let index = characters.length - 1; index >= 0; index -= 1) {
        if (contextBytes(characters[index] + result) > maxBytes) break;
        result = characters[index] + result;
    }
    return result;
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}
