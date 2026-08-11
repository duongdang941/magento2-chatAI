import axios from 'axios';
import { createInternalMagentoRequestConfig } from './magento-auth.js';

const MAGENTO_URL = process.env.MAGENTO_API_URL || 'http://afd.test';
const GUEST_ORDER_ENDPOINT = '/afd_ai/chat/guestOrders';

export async function guestOrderAction(action, sessionId, payload = {}) {
    const url = `${MAGENTO_URL}${GUEST_ORDER_ENDPOINT}`;
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
