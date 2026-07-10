import axios from 'axios';
import { createInternalMagentoRequestConfig } from '../gateway/magento-auth.js';
import { resolveMagentoBaseUrl } from '../gateway/magento-url.js';
const CUSTOMER_ADDRESS_ENDPOINT = '/afd_ai/chat/customerAddresses';

/** Customer ID comes only from the verified WebSocket ticket. */
export async function executeCustomerAddressAction(customerId, action, payload = {}, catalogScope = null) {
    const verifiedCustomerId = Number(customerId);
    if (!Number.isInteger(verifiedCustomerId) || verifiedCustomerId < 1) {
        return {
            status: 'requires_customer_action',
            reason: 'not_logged_in',
            message: 'Please sign in to view or change your account addresses.'
        };
    }

    const url = `${resolveMagentoBaseUrl(catalogScope)}${CUSTOMER_ADDRESS_ENDPOINT}`;
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
        : { status: 'error', message: 'The customer address service returned an invalid response.' };
}
