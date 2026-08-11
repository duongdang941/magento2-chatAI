import { activeAddressFormCacheKey } from './address-update-admission.js';
import { issueAddressFormToken } from './address-form-token.js';
import { rehydrateCatalogContinuation } from './catalog-pagination.js';
import { summarizeError } from './error-summary.js';

/**
 * Rehydrate structured history without leaking expired address data.
 *
 * Access predicates and support lookup are injected so this service remains
 * independent of the WebSocket composition root and can be regression-tested
 * without starting the gateway.
 */
export function createHistoryMessagePreparer({
    runtime,
    normalizeStoredAssistantMessage,
    hasActiveSupportEmailVerification,
    listSupportCases,
    supportPortalIdentity,
    hasActiveGuestOrderAccess,
    addressUpdateAdmission
}) {
    return async function prepareHistoryMessages(sourceMessages, client, conversationId) {
        const messages = (Array.isArray(sourceMessages) ? sourceMessages : [])
            .map(message => normalizeStoredAssistantMessage(message));
        messages.forEach(message => {
            (Array.isArray(message?.parts) ? message.parts : []).forEach(part => {
                if (part?.type === 'products' && part.payload && typeof part.payload === 'object') {
                    part.payload = rehydrateCatalogContinuation(part.payload);
                }
            });
        });
        const now = Date.now();
        const cacheKey = activeAddressFormCacheKey(client, conversationId);
        const cached = await runtime.getAuthCache(cacheKey);
        let activeFormId = String(cached?.formId || '');

        const forms = [];
        const supportAccessForms = [];
        messages.forEach(message => {
            (Array.isArray(message?.parts) ? message.parts : []).forEach(part => {
                if (part?.type === 'order_address_form') forms.push(part);
                if (part?.type === 'guest_order_access' && part?.purpose === 'support') {
                    supportAccessForms.push(part);
                }
            });
        });

        if (supportAccessForms.length > 0 && hasActiveSupportEmailVerification(client)) {
            let supportPortal = { status: 'error', cases: [] };
            try {
                supportPortal = await listSupportCases(supportPortalIdentity(client));
            } catch (error) {
                console.warn('[Support] Could not restore verified ticket list:', summarizeError(error));
            }
            if (supportPortal?.status === 'success') {
                supportAccessForms.forEach(form => {
                    form.state = 'verified';
                    form.tickets = Array.isArray(supportPortal.cases) ? supportPortal.cases : [];
                });
            }
        }

        if (!activeFormId) {
            const newest = [...forms].reverse().find(part => Number(part.expires_at) > now);
            activeFormId = String(newest?.form_id || '');
        }

        for (const form of forms) {
            const resourceType = form.resource_type === 'customer_account' ? 'customer_account' : 'order';
            const isGuestOrder = resourceType === 'order' && !client.customerId;
            const permitted = !(resourceType === 'customer_account' && !client.customerId)
                && !(isGuestOrder && !hasActiveGuestOrderAccess(client));
            const isActive = permitted
                && String(form.form_id || '') === activeFormId
                && Number(form.expires_at) > now;

            if (!isActive) {
                form.action_token = '';
                form.expires_at = Math.min(Number(form.expires_at) || now - 1, now - 1);
                form.addresses = Object.fromEntries(
                    (Array.isArray(form.address_types) ? form.address_types : [])
                        .filter(type => ['billing', 'shipping'].includes(type))
                        .map(type => [type, {}])
                );
                continue;
            }

            form.action_token = issueAddressFormToken({
                formId: form.form_id,
                resourceType,
                customerId: client.customerId,
                sessionId: client.sessionId,
                conversationId,
                orderNumber: form.order_number,
                expiresAt: form.expires_at,
                addressTypes: form.address_types
            });
            if (form.action_token) {
                await addressUpdateAdmission.activate(client, conversationId, form);
            }
        }

        return messages;
    };
}
