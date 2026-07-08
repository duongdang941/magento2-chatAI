export function guestOrderAccessCacheKey(sessionId) {
    return 'guest-order-access:' + sessionId;
}

export function supportEmailVerificationCacheKey(sessionId) {
    return 'support-email-access:' + sessionId;
}

export function normalizeGuestOrderAccessExpiry(value) {
    const numeric = Math.floor(Number(value) || 0);
    if (!numeric) return 0;
    if (numeric < 10000000000) return numeric * 1000;
    return numeric;
}

export function hasActiveGuestOrderAccess(client) {
    return Boolean(client && client.guestOrderAccessToken && client.guestOrderEmail && Number(client.guestOrderAccessExpiresAt) > Date.now());
}

export function hasActiveSupportEmailVerification(client) {
    return Boolean(client && client.supportEmail && client.supportEmailAccessToken && Number(client.supportEmailVerifiedUntil) > Date.now());
}

export function guestOrderAccessState(client, state) {
    const verified = state === 'verified' && hasActiveGuestOrderAccess(client);
    let expiresAt = null;
    if (verified) expiresAt = Math.floor(client.guestOrderAccessExpiresAt / 1000);
    return { type: 'guest_order_access_state', state: verified ? 'verified' : 'email', expires_at: expiresAt };
}

export function guestOrderAccessNeedsVerification(result) {
    return ['guest_access_required', 'guest_reverification_required'].includes(String((result && result.reason) || '').toLowerCase());
}
