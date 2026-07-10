import axios from 'axios';
import { createInternalMagentoRequestConfig } from '../gateway/magento-auth.js';
import { resolveMagentoBaseUrl } from '../gateway/magento-url.js';
const ORDER_ENDPOINT = '/afd_ai/chat/orders';

/**
 * Sends a customer-order operation to Magento using the Node/Magento HMAC.
 * customerId comes exclusively from the verified WebSocket ticket, never from
 * model arguments or browser input.
 */
export async function executeCustomerOrderAction(customerId, action, payload = {}, catalogScope = null) {
    const verifiedCustomerId = Number(customerId);
    if (!Number.isInteger(verifiedCustomerId) || verifiedCustomerId < 1) {
        return {
            status: 'requires_customer_action',
            reason: 'not_logged_in',
            message: 'Please sign in to view or change your orders.'
        };
    }

    const url = `${resolveMagentoBaseUrl(catalogScope)}${ORDER_ENDPOINT}`;
    const body = JSON.stringify({
        ...payload,
        customerId: verifiedCustomerId,
        action
    });
    const response = await axios.post(
        url,
        body,
        createInternalMagentoRequestConfig('POST', url, body, { timeout: 15000 })
    );

    return response.data && typeof response.data === 'object'
        ? response.data
        : { status: 'error', message: 'The order service returned an invalid response.' };
}
