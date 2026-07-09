const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_LENGTH = 12000;
const MAX_HISTORY_ITEMS = 40;

function normalizePurpose(value) {
    return value === 'support' ? 'support' : 'order';
}

function safeText(value, maxLength = MAX_TEXT_LENGTH) {
    return String(value || '').trim().slice(0, maxLength);
}

function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];

    return history.slice(-MAX_HISTORY_ITEMS).map((message) => {
        const role = message?.role === 'assistant' ? 'assistant' : 'user';
        const content = safeText(message?.content ?? message?.text ?? message?.raw ?? '');
        const parts = Array.isArray(message?.parts)
            ? message.parts
                .map((part) => ({
                    type: safeText(part?.type, 40),
                    text: safeText(part?.text ?? part?.raw ?? part?.content ?? '')
                }))
                .filter((part) => part.text)
            : [];

        return { role, content, parts };
    }).filter((message) => message.content || message.parts.length > 0);
}

export function rememberPendingVerificationAction(client, action = {}, options = {}) {
    if (!client) return null;

    const now = Number(options.now) || Date.now();
    const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
    const text = safeText(action.text);
    const conversationId = Math.max(0, Math.trunc(Number(action.conversationId) || 0));
    if (!text || !conversationId) return null;

    const pending = {
        purpose: normalizePurpose(action.purpose),
        conversationId,
        text,
        history: sanitizeHistory(action.history),
        createdAt: now,
        expiresAt: now + ttlMs
    };
    client.pendingVerificationAction = pending;
    return pending;
}

export function consumePendingVerificationAction(client, purpose, options = {}) {
    if (!client?.pendingVerificationAction) return null;

    const pending = client.pendingVerificationAction;
    const now = Number(options.now) || Date.now();
    if (pending.expiresAt <= now || pending.purpose !== normalizePurpose(purpose)) {
        if (pending.expiresAt <= now) {
            client.pendingVerificationAction = null;
        }
        return null;
    }

    // Consume before executing so duplicate verification responses cannot
    // replay an order or create a second support ticket.
    client.pendingVerificationAction = null;
    return pending;
}

export function clearPendingVerificationAction(client) {
    if (client) client.pendingVerificationAction = null;
}
