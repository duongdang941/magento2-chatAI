import crypto from 'node:crypto';

const TOKEN_AUDIENCE = 'afd-ai-address-form';
const MAX_TOKEN_LENGTH = 2048;

function tokenSecret(override = '') {
    return String(override || process.env.AI_WS_TICKET_SECRET || '');
}

function encode(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value) {
    try {
        return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function identity({ customerId, sessionId }) {
    const id = Number(customerId);
    if (Number.isInteger(id) && id > 0) return `customer:${id}`;
    const session = String(sessionId || '').trim();
    return session ? `guest:${session}` : '';
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueAddressFormToken(options = {}, secretOverride = '') {
    const secret = tokenSecret(secretOverride);
    const formId = String(options.formId || '').trim().slice(0, 160);
    const subject = identity(options);
    const resourceType = options.resourceType === 'customer_account' ? 'customer_account' : 'order';
    const conversationId = Number(options.conversationId);
    const expiresAt = Math.floor(Number(options.expiresAt) || 0);
    const addressTypes = (Array.isArray(options.addressTypes) ? options.addressTypes : [])
        .filter((type, index, values) => ['billing', 'shipping'].includes(type) && values.indexOf(type) === index);

    if (secret.length < 32
        || !formId
        || !subject
        || !Number.isInteger(conversationId)
        || conversationId < 1
        || expiresAt <= Date.now()
        || addressTypes.length === 0
    ) {
        return '';
    }

    const payload = {
        aud: TOKEN_AUDIENCE,
        fid: formId,
        res: resourceType,
        sub: subject,
        cid: conversationId,
        ord: resourceType === 'order' ? String(options.orderNumber || '').slice(0, 64) : '',
        types: addressTypes,
        exp: expiresAt,
        nonce: crypto.randomBytes(12).toString('base64url')
    };
    const encoded = encode(payload);
    const signature = crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
    return `${encoded}.${signature}`;
}

export function verifyAddressFormToken(token, expected = {}, secretOverride = '') {
    const secret = tokenSecret(secretOverride);
    const value = String(token || '');
    if (secret.length < 32 || !value || value.length > MAX_TOKEN_LENGTH) {
        return { valid: false, reason: 'invalid_form_token' };
    }

    const [encoded, signature, ...rest] = value.split('.');
    if (!encoded || !signature || rest.length > 0) {
        return { valid: false, reason: 'invalid_form_token' };
    }
    const calculated = crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
    const payload = safeEqual(signature, calculated) ? decode(encoded) : null;
    if (!payload || payload.aud !== TOKEN_AUDIENCE || Number(payload.exp) <= Date.now()) {
        return { valid: false, reason: Number(payload?.exp) <= Date.now() ? 'form_expired' : 'invalid_form_token' };
    }

    const expectedIdentity = identity(expected);
    const expectedResource = expected.resourceType === 'customer_account' ? 'customer_account' : 'order';
    const expectedType = String(expected.addressType || '');
    const matches = payload.fid === String(expected.formId || '')
        && payload.res === expectedResource
        && payload.sub === expectedIdentity
        && Array.isArray(payload.types)
        && payload.types.includes(expectedType)
        && (!expected.conversationId || Number(payload.cid) === Number(expected.conversationId))
        && (expectedResource !== 'order' || payload.ord === String(expected.orderNumber || ''));

    return matches
        ? { valid: true, payload }
        : { valid: false, reason: 'invalid_form_token' };
}

export { TOKEN_AUDIENCE };
