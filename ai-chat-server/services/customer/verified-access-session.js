import {
    guestOrderAccessCacheKey,
    hasActiveGuestOrderAccess,
    hasActiveSupportEmailVerification,
    normalizeGuestOrderAccessExpiry,
    guestOrderAccessState,
    supportEmailVerificationCacheKey
} from '../security/guest-access.js';
import { guestHistoryIdentity } from '../conversation/guest-history.js';

const GUEST_ORDER_ACCESS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORT_EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000;

/**
 * Owns the short-lived verified identities used by guest orders and support.
 * Browser input never decides customer/order ownership; Magento validates the
 * access token again at every protected tool/API boundary.
 */
export function createVerifiedAccessSession({
    runtime,
    getSupportConversationState,
    listSupportCases,
    summarizeError,
    broadcastGuestSession,
    isSocketOpen
}) {
    async function supportConversationState(client, conversationId) {
        try {
            const state = await getSupportConversationState({
                customerId: client?.customerId || 0,
                guestId: client?.customerId ? '' : guestHistoryIdentity(client),
                catalogScope: client?.catalogScope || null
            }, conversationId, client?.catalogScope || null);
            return {
                active: state?.active === true,
                closed: state?.closed === true,
                isSupport: state?.is_support === true,
                status: String(state?.status || '').slice(0, 24),
                agentLabel: String(state?.agent_label || '').slice(0, 80)
            };
        } catch (error) {
            console.warn('[Support] Could not read live-chat state:', summarizeError(error));
            return { active: false, closed: false, isSupport: false, status: '', agentLabel: '' };
        }
    }

    async function hydrateSupportEmailVerification(client) {
        if (!client?.sessionId) return false;
        if (hasActiveSupportEmailVerification(client)) return true;

        const cacheKey = supportEmailVerificationCacheKey(client.sessionId);
        const cached = await runtime.getAuthCache(cacheKey);
        const accessToken = String(cached?.accessToken || '');
        const email = String(cached?.email || '');
        const expiresAt = Number(cached?.expiresAt);
        const valid = /^[a-f0-9]{64}$/i.test(accessToken)
            && /^\S+@\S+\.\S+$/.test(email)
            && Number.isFinite(expiresAt)
            && expiresAt > Date.now();

        if (!valid) {
            if (cached) await runtime.deleteAuthCache(cacheKey);
            return false;
        }

        client.supportEmail = email.toLowerCase();
        client.supportEmailAccessToken = accessToken;
        client.supportEmailVerifiedUntil = expiresAt;
        return true;
    }

    async function rememberSupportEmailVerification(client, email, token, reportedExpiry) {
        if (!client?.sessionId) return false;
        const now = Date.now();
        const normalizedExpiry = normalizeGuestOrderAccessExpiry(reportedExpiry);
        const expiresAt = Math.min(
            normalizedExpiry > now ? normalizedExpiry : now + SUPPORT_EMAIL_VERIFICATION_TTL_MS,
            now + SUPPORT_EMAIL_VERIFICATION_TTL_MS
        );
        const ttlMs = expiresAt - now;
        if (ttlMs <= 0) return false;

        client.supportEmail = String(email).trim().toLowerCase();
        client.supportEmailAccessToken = String(token);
        client.supportEmailVerifiedUntil = expiresAt;
        await runtime.setAuthCache(supportEmailVerificationCacheKey(client.sessionId), {
            email: client.supportEmail,
            accessToken: client.supportEmailAccessToken,
            expiresAt
        }, ttlMs);
        return true;
    }

    function supportPortalIdentity(client) {
        if (!hasActiveSupportEmailVerification(client)) return null;
        return {
            customerId: client.customerId || null,
            guestId: client.customerId ? null : guestHistoryIdentity(client),
            verifiedEmail: client.supportEmail,
            verificationToken: client.supportEmailAccessToken,
            verificationSessionId: client.sessionId,
            catalogScope: client.catalogScope || null
        };
    }

    async function sendSupportPortal(ws, client, formId = '') {
        const identity = supportPortalIdentity(client);
        if (!identity) {
            ws.send(JSON.stringify({
                type: 'support_portal_result',
                form_id: String(formId || ''),
                result: { status: 'requires_customer_action', reason: 'guest_access_required', cases: [] }
            }));
            return;
        }

        let result;
        try {
            result = await listSupportCases(identity);
        } catch (error) {
            console.warn('[Support] Could not load customer tickets:', summarizeError(error));
            result = { status: 'error', message: 'Your support tickets could not be loaded.', cases: [] };
        }
        ws.send(JSON.stringify({ type: 'support_portal_result', form_id: String(formId || ''), result }));
    }

    async function clearSupportEmailVerification(client) {
        if (!client) return;
        client.supportEmail = '';
        client.supportEmailAccessToken = '';
        client.supportEmailVerifiedUntil = 0;
        if (client.sessionId) {
            await runtime.deleteAuthCache(supportEmailVerificationCacheKey(client.sessionId));
        }
    }

    async function hydrateGuestOrderAccess(client) {
        if (!client || client.customerId || !client.sessionId) return false;

        if (client.guestOrderAccessToken) {
            if (hasActiveGuestOrderAccess(client)) return true;
            await clearGuestOrderAccess(client);
        }

        const cacheKey = guestOrderAccessCacheKey(client.sessionId);
        const cached = await runtime.getAuthCache(cacheKey);
        const accessToken = String(cached?.accessToken || '');
        const email = String(cached?.email || '');
        const expiresAt = Number(cached?.expiresAt);
        const valid = /^[a-f0-9]{64}$/i.test(accessToken)
            && /^\S+@\S+\.\S+$/.test(email)
            && Number.isFinite(expiresAt)
            && expiresAt > Date.now();

        if (!valid) {
            if (cached) await runtime.deleteAuthCache(cacheKey);
            return false;
        }

        client.guestOrderEmail = email.toLowerCase();
        client.guestOrderAccessToken = accessToken;
        client.guestOrderAccessExpiresAt = expiresAt;
        return true;
    }

    async function rememberGuestOrderAccess(client, email, token, expiresInSeconds, expiresAtSeconds) {
        if (!client?.sessionId) return false;
        const now = Date.now();
        const reportedExpiresAt = normalizeGuestOrderAccessExpiry(expiresAtSeconds);
        const fallbackExpiresAt = now + Math.max(
            1000,
            Math.min(
                GUEST_ORDER_ACCESS_MAX_TTL_MS,
                Number(expiresInSeconds || 0) * 1000 || GUEST_ORDER_ACCESS_MAX_TTL_MS
            )
        );
        const expiresAt = Math.min(
            now + GUEST_ORDER_ACCESS_MAX_TTL_MS,
            reportedExpiresAt > 0 ? reportedExpiresAt : fallbackExpiresAt
        );
        const ttlMs = expiresAt - now;
        if (ttlMs <= 0) return false;

        client.guestOrderEmail = String(email).trim().toLowerCase();
        client.guestOrderAccessToken = String(token);
        client.guestOrderAccessExpiresAt = expiresAt;
        await runtime.setAuthCache(guestOrderAccessCacheKey(client.sessionId), {
            email: client.guestOrderEmail,
            accessToken: client.guestOrderAccessToken,
            expiresAt
        }, ttlMs);
        return true;
    }

    async function clearGuestOrderAccess(client) {
        if (!client) return;
        client.guestOrderEmail = '';
        client.guestOrderAccessToken = '';
        client.guestOrderAccessExpiresAt = 0;
        if (client.sessionId) {
            await runtime.deleteAuthCache(guestOrderAccessCacheKey(client.sessionId));
        }
    }

    async function notifyGuestOrderAccessReset(origin, client) {
        await clearGuestOrderAccess(client);
        const state = guestOrderAccessState(client, 'email');
        if (isSocketOpen(origin)) origin.send(JSON.stringify(state));
        broadcastGuestSession(origin, client, state);
    }

    return {
        clearGuestOrderAccess,
        clearSupportEmailVerification,
        hydrateGuestOrderAccess,
        hydrateSupportEmailVerification,
        notifyGuestOrderAccessReset,
        rememberGuestOrderAccess,
        rememberSupportEmailVerification,
        sendSupportPortal,
        supportConversationState,
        supportPortalIdentity
    };
}
