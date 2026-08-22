import crypto from 'node:crypto';
import { normalizeCatalogScope } from '../catalog/catalog-scope.js';
import { normalizePageContext } from '../catalog/page-context.js';

const TOKEN_AUDIENCE = 'afd-ai-websocket';
const MAX_CLOCK_SKEW_SECONDS = 15;
const TENANT_ID_PATTERN = /^[a-f0-9]{64}$/i;

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, 'base64');
}

function parsePart(value) {
    try {
        return JSON.parse(base64UrlDecode(value).toString('utf8'));
    } catch {
        return null;
    }
}

function validSignature(signature, expected) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(signature || ''))) return false;
    const actual = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(expected);
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function normalizeTenantId(value) {
    const tenantId = String(value || '').trim().toLowerCase();
    return TENANT_ID_PATTERN.test(tenantId) ? tenantId : '';
}

function decryptCheckoutSession(encryptedSession, secret) {
    try {
        const payload = base64UrlDecode(encryptedSession);
        const nonce = payload.subarray(0, 12);
        const tag = payload.subarray(12, 28);
        const ciphertext = payload.subarray(28);
        if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
            return '';
        }

        const key = crypto
            .createHmac('sha256', secret)
            .update('afd-ai-websocket-ticket-session-v1', 'utf8')
            .digest();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(tag);
        decipher.setAAD(Buffer.from(TOKEN_AUDIENCE, 'utf8'));
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

/**
 * Validates a Magento-issued, short-lived ticket at WebSocket admission. It
 * intentionally contains only the identity needed for a socket connection and
 * no provider secrets. Its expiry limits opening a connection, not the life
 * of an already-authenticated WebSocket session.
 */
export function verifyWebSocketTicket(ticket, secret = process.env.AI_WS_TICKET_SECRET || '') {
    if (String(secret).length < 32) {
        throw new Error('AI_WS_TICKET_SECRET must be configured with at least 32 characters.');
    }

    const [encodedHeader, encodedPayload, signature, ...rest] = String(ticket || '').split('.');
    if (!encodedHeader || !encodedPayload || !signature || rest.length > 0) {
        throw new Error('WebSocket ticket is malformed.');
    }

    const header = parsePart(encodedHeader);
    const claims = parsePart(encodedPayload);
    if (!header || !claims || header.alg !== 'HS256' || header.typ !== 'JWT') {
        throw new Error('WebSocket ticket header is invalid.');
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`, 'utf8')
        .digest('base64url');
    if (!validSignature(signature, expected)) {
        throw new Error('WebSocket ticket signature is invalid.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== TOKEN_AUDIENCE
        || !claims.jti
        || !claims.sid
        || !Number.isInteger(claims.iat)
        || !Number.isInteger(claims.exp)
        || claims.iat > now + MAX_CLOCK_SKEW_SECONDS
        || claims.exp <= now) {
        throw new Error('WebSocket ticket is expired or invalid.');
    }

    if (claims.role === 'support_admin') {
        const adminId = Number(claims.aid || 0);
        if (!Number.isInteger(adminId) || adminId < 1) {
            throw new Error('WebSocket administrator ticket is invalid.');
        }

        return {
            adminId,
            adminName: String(claims.name || 'Support team').trim().slice(0, 80) || 'Support team',
            customerId: null,
            sessionId: String(claims.sid),
            sessionCookie: '',
            ticketId: String(claims.jti),
            expiresAt: Number(claims.exp) * 1000,
            role: 'support_admin',
            source: 'ticket'
        };
    }

    if (!claims.sct || !claims.scn) {
        throw new Error('WebSocket ticket checkout session is invalid.');
    }

    const customerId = Number(claims.sub || 0);
    const rawTenantId = String(claims.tenant_id || '').trim();
    if (rawTenantId !== '' && !TENANT_ID_PATTERN.test(rawTenantId)) {
        throw new Error('WebSocket ticket tenant identity is invalid.');
    }
    const tenantId = normalizeTenantId(rawTenantId);
    const catalogScope = normalizeCatalogScope({
        ...(claims.catalog_scope && typeof claims.catalog_scope === 'object' ? claims.catalog_scope : {}),
        ...(tenantId ? { tenant_id: tenantId } : {})
    });
    const pageContext = normalizePageContext(claims.page_context);
    const guestHistoryId = String(claims.gid || '').toLowerCase();
    if (!customerId && !/^[a-f0-9]{64}$/.test(guestHistoryId)) {
        throw new Error('WebSocket guest chat identity is invalid.');
    }
    const checkoutSessionId = decryptCheckoutSession(claims.sct, secret);
    const checkoutSessionName = String(claims.scn || '').trim();
    if (!checkoutSessionId || !/^[A-Za-z0-9_-]{1,80}$/.test(checkoutSessionName)) {
        throw new Error('WebSocket ticket checkout session is invalid.');
    }

    return {
        customerId: Number.isInteger(customerId) && customerId > 0 ? customerId : null,
        sessionId: String(claims.sid),
        guestHistoryId,
        sessionCookie: `${checkoutSessionName}=${encodeURIComponent(checkoutSessionId)}`,
        ticketId: String(claims.jti),
        expiresAt: Number(claims.exp) * 1000,
        role: 'customer',
        source: 'ticket',
        ...(tenantId ? { tenantId } : {}),
        ...(catalogScope ? { catalogScope } : {}),
        ...(pageContext ? { pageContext } : {})
    };
}

export { TOKEN_AUDIENCE };
