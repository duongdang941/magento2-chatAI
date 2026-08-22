import axios from 'axios';
import { createInternalMagentoRequestConfig } from '../gateway/magento-auth.js';
import { resolveMagentoBaseUrl } from '../gateway/magento-url.js';
const GUEST_ORDER_ENDPOINT = '/afd_ai/chat/guestOrders';

export async function guestOrderAction(action, sessionId, payload = {}, catalogScope = null) {
    const url = `${resolveMagentoBaseUrl(catalogScope)}${GUEST_ORDER_ENDPOINT}`;
    const body = JSON.stringify({
        ...payload,
        action,
        sessionId
    });
    const response = await axios.post(
        url,
        body,
        createInternalMagentoRequestConfig('POST', url, body, { timeout: 15000 })
    );

    return response.data && typeof response.data === 'object'
        ? response.data
        : { status: 'error', message: 'The guest-order service returned an invalid response.' };
}
