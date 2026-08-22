import { verifyAddressFormToken } from './address-form-token.js';

const stableIdentity = (client) => {
    const tenant = client?.tenantId || client?.catalogScope?.tenantId || '';
    const prefix = tenant ? `tenant:${tenant}:` : '';
    return client?.customerId
        ? `${prefix}customer:${client.customerId}`
        : `${prefix}session:${String(client?.sessionId || '')}`;
};

/**
 * Canonical owner-scoped key for the single active address form in a chat.
 *
 * History hydration and mutation admission must resolve exactly the same key;
 * exporting it avoids a second, subtly different implementation in the
 * gateway composition root.
 */
export const activeAddressFormCacheKey = (client, conversationId) => (
    `active-address-form:${stableIdentity(client)}:${Number(conversationId) || 0}`
);

export function createAddressUpdateAdmission({ runtime, getConfig, defaults = {} }) {
    async function activate(client, conversationId, form) {
        const formId = String(form?.form_id || '').slice(0, 160);
        const expiresAt = Math.floor(Number(form?.expires_at) || 0);
        if (!formId || Number(conversationId) < 1 || expiresAt <= Date.now()) return false;
        await runtime.setAuthCache(
            activeAddressFormCacheKey(client, conversationId),
            { formId, expiresAt },
            expiresAt - Date.now()
        );
        return true;
    }

    async function admit(client, data, expected) {
        const verification = verifyAddressFormToken(data.action_token || data.actionToken, {
            formId: String(data.form_id || '').slice(0, 160),
            resourceType: expected.resourceType,
            customerId: client.customerId,
            sessionId: client.sessionId,
            orderNumber: expected.orderNumber || '',
            addressType: expected.addressType
        });
        if (!verification.valid) return { result: invalidFormResult(verification.reason) };

        const conversationId = Number(verification.payload?.cid);
        const activeForm = await runtime.getAuthCache(activeAddressFormCacheKey(client, conversationId));
        if (!activeForm || activeForm.formId !== String(data.form_id || '')) {
            return { result: actionRequired('form_superseded', 'A newer address form is active. Please use the latest form in this conversation.') };
        }

        const identity = `${stableIdentity(client)}:address-update`;
        const config = await getConfig(
            runtime,
            client?.catalogScope?.storeCode || '',
            client?.tenantId || client?.catalogScope?.tenantId || ''
        );
        const limits = config.rate_limits || {};
        const minute = await runtime.consumeRateLimit(`${identity}:minute`, {
            limit: limits.address_updates_per_minute || defaults.perMinute || 5,
            windowMs: 60 * 1000
        });
        const hour = await runtime.consumeRateLimit(`${identity}:hour`, {
            limit: limits.address_updates_per_hour || defaults.perHour || 20,
            windowMs: 60 * 60 * 1000
        });
        if (!minute.allowed || !hour.allowed) {
            const retryAfterMs = Math.max(
                minute.allowed ? 0 : minute.retryAfterMs,
                hour.allowed ? 0 : hour.retryAfterMs
            );
            return { result: {
                ...actionRequired('rate_limited', 'Too many address updates. Please wait before trying again.'),
                retry_after: Math.max(1, Math.ceil(retryAfterMs / 1000))
            } };
        }

        const lock = await runtime.acquireActionLock(
            'address-update',
            identity,
            defaults.lockMs || 20000
        );
        return lock
            ? { lock }
            : { result: actionRequired('update_in_progress', 'An address update is already in progress. Please wait for it to finish.') };
    }

    return Object.freeze({ activate, admit });
}

function invalidFormResult(reason) {
    return actionRequired(
        reason,
        reason === 'form_expired'
            ? 'This address form has expired. Ask for a new form to continue.'
            : 'This address form could not be verified. Ask for a new form to continue.'
    );
}

function actionRequired(reason, message) {
    return { status: 'requires_customer_action', reason, message };
}
