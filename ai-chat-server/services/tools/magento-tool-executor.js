import axios from 'axios';

import { listSupportCases, searchStoreKnowledge, subscribeBackInStock } from '../assistant-service-client.js';
import { normalizeMagentoToolResponse } from '../catalog-page-loader.js';
import { DEFAULT_CATALOG_PAGE_SIZE, MAX_CATALOG_PAGE_SIZE } from '../catalog-pagination.js';
import {
    normalizeAddToCartArguments,
    normalizeAvailabilityArguments,
    normalizeRemoveFromCartArguments,
    normalizeSearchArguments
} from '../catalog-tool-arguments.js';
import { executeCustomerAddressAction } from '../customer-address-client.js';
import { executeCustomerOrderAction } from '../customer-order-client.js';
import { summarizeError } from '../error-summary.js';
import {
    normalizeCustomerAddressArguments,
    normalizeOrderAddressArguments,
    normalizeOrderDetailsArguments,
    normalizeRecentOrdersArguments
} from '../customer-order-tool-arguments.js';
import { hashKey } from '../gateway-runtime.js';
import { guestOrderAction } from '../guest-order-client.js';
import { createMagentoRequestConfig } from '../magento-auth.js';

const MAGENTO_URL = process.env.MAGENTO_API_URL || 'http://afd.test';

/**
 * Provider-neutral Magento tool executor. Provider adapters own protocol
 * streaming only; authorization and commerce semantics remain identical.
 */
export async function executeRegisteredMagentoTool(name, args = {}, context = {}) {
    const {
        token = null,
        magentoOauth = {},
        runtime = null,
        requestBrowserCart = null,
        customerId = null,
        guestOrderAccess = null,
        supportEmailAccess = null,
        conversationId = null,
        guestId = null,
        shopperMessage = ''
    } = context;

    try {
        switch (name) {
            case 'searchProducts': {
                const params = normalizeSearchArguments(
                    args,
                    MAX_CATALOG_PAGE_SIZE,
                    DEFAULT_CATALOG_PAGE_SIZE,
                    shopperMessage
                );
                const url = `${MAGENTO_URL}/rest/V1/afd-ai/products/search`;
                return cachedMagentoRead(runtime, 'catalog-search', { params, token }, 60000, async () => {
                    const response = await axios.get(url, {
                        ...magentoRequest('GET', url, { signParams: params, magentoOauth }),
                        params
                    });
                    return normalizeMagentoToolResponse(response.data);
                });
            }

            case 'getProductAvailability': {
                const params = normalizeAvailabilityArguments(args);
                const url = `${MAGENTO_URL}/rest/V1/afd-ai/products/availability`;
                return cachedMagentoRead(runtime, 'catalog-availability', { params, token }, 15000, async () => {
                    const response = await axios.get(url, {
                        ...magentoRequest('GET', url, { signParams: params, magentoOauth }),
                        params
                    });
                    return normalizeMagentoToolResponse(response.data);
                });
            }

            case 'compareProducts': {
                const params = {
                    sku1: String(args.sku1 || '').trim().slice(0, 64),
                    sku2: String(args.sku2 || '').trim().slice(0, 64)
                };
                if (!params.sku1 || !params.sku2) {
                    return actionRequired('missing_skus', 'Choose two products to compare.');
                }
                const url = `${MAGENTO_URL}/rest/V1/afd-ai/products/compare`;
                const response = await axios.get(url, {
                    ...magentoRequest('GET', url, { signParams: params, magentoOauth }),
                    params
                });
                return normalizeMagentoToolResponse(response.data);
            }

            case 'listCategories': {
                const url = `${MAGENTO_URL}/rest/V1/afd-ai/categories`;
                const response = await axios.get(url, magentoRequest('GET', url, { magentoOauth }));
                return normalizeMagentoToolResponse(response.data);
            }

            case 'addToCart':
            case 'removeFromCart': {
                if (typeof requestBrowserCart !== 'function') {
                    return { status: 'error', reason: 'cart_bridge_unavailable', message: 'The storefront cart connection is unavailable.' };
                }
                return requestBrowserCart(name === 'addToCart'
                    ? normalizeAddToCartArguments(args, shopperMessage)
                    : normalizeRemoveFromCartArguments(args));
            }

            case 'getCustomerAddresses':
                return executeCustomerAddressAction(customerId, 'get');

            case 'updateCustomerAddress': {
                const normalized = normalizeCustomerAddressArguments(args);
                if (!normalized.addressType || Object.keys(normalized.address).length === 0) {
                    return actionRequired('missing_address_details', 'Submit the secure address form shown in chat.');
                }
                return executeCustomerAddressAction(customerId, 'update', normalized);
            }

            case 'getRecentOrders':
                return executeCustomerOrderAction(customerId, 'list', normalizeRecentOrdersArguments(args));

            case 'getGuestOrders':
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                return guestOrderAction('list', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    limit: normalizeRecentOrdersArguments(args).limit
                });

            case 'getGuestOrderDetails': {
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return guestOrderAction('details', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    ...normalized
                });
            }

            case 'updateGuestOrderAddress': {
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                const normalized = normalizeOrderAddressArguments(args);
                if (!validAddressUpdate(normalized)) return missingAddressDetails();
                return guestOrderAction('update_address', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    ...normalized
                });
            }

            case 'getOrderDetails':
            case 'getOrderFulfillment': {
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return executeCustomerOrderAction(
                    customerId,
                    name === 'getOrderFulfillment' ? 'fulfillment' : 'details',
                    normalized
                );
            }

            case 'updateOrderAddress': {
                const normalized = normalizeOrderAddressArguments(args);
                if (!validAddressUpdate(normalized)) return missingAddressDetails();
                return executeCustomerOrderAction(customerId, 'update_address', normalized);
            }

            case 'cancelOrder': {
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return executeCustomerOrderAction(customerId, 'cancel', {
                    ...normalized,
                    confirmed: args.confirmed === true
                });
            }

            case 'requestReturn': {
                const normalized = normalizeOrderDetailsArguments(args);
                const reason = String(args.reason || '').trim().slice(0, 4000);
                if (!normalized.orderNumber || !reason) {
                    return actionRequired('return_details_required', 'Please provide the order number and return reason.');
                }
                return executeCustomerOrderAction(customerId, 'request_return', {
                    ...normalized,
                    conversationId: Math.max(0, Math.trunc(Number(conversationId) || 0)),
                    reason,
                    skus: Array.isArray(args.skus)
                        ? args.skus.slice(0, 20).map((sku) => String(sku).slice(0, 64))
                        : []
                });
            }

            case 'searchStoreKnowledge':
                return searchStoreKnowledge(args.query, args.limit);

            case 'handoffToHuman':
                if (!supportEmailAccess?.email || !supportEmailAccess?.token || !supportEmailAccess?.sessionId) {
                    return { ...guestAccessRequired(), purpose: 'support', message: 'Verify your email before starting human support.' };
                }
                return listSupportCases({
                    customerId,
                    guestId,
                    verifiedEmail: supportEmailAccess.email,
                    verificationToken: supportEmailAccess.token,
                    verificationSessionId: supportEmailAccess.sessionId
                });

            case 'subscribeBackInStock':
                return subscribeBackInStock(customerId, args.sku);

            default:
                return { status: 'error', reason: 'unknown_tool', message: 'Tool is not registered.' };
        }
    } catch (error) {
        console.error(`Tool Execution Error [${name}]:`, summarizeError(error));
        return {
            status: 'error',
            reason: 'tool_execution_failed',
            message: 'The store service could not complete this request. Please try again.'
        };
    }
}

function magentoRequest(method, url, options = {}) {
    const config = createMagentoRequestConfig(method, url, {
        timeout: 20000,
        signParams: options.signParams || {},
        magentoOauth: options.magentoOauth || {}
    });
    if (!config.headers.Authorization) {
        throw new Error('Magento gateway OAuth credentials are not configured.');
    }
    return config;
}

async function cachedMagentoRead(runtime, namespace, identity, ttlMs, loader) {
    if (!runtime || typeof runtime.getOrSetJsonCache !== 'function') return loader();
    const scope = identity.token ? `customer:${hashKey(identity.token)}` : 'guest';
    const cached = await runtime.getOrSetJsonCache(namespace, stableJson({
        scope,
        params: identity.params || {}
    }), {
        ttlMs,
        lockMs: Math.min(15000, ttlMs),
        waitMs: Math.min(20000, ttlMs + 2000)
    }, loader);
    return cached.value;
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function actionRequired(reason, message) {
    return { status: 'requires_customer_action', reason, message };
}

function guestAccessRequired() {
    return actionRequired('guest_access_required', 'Complete the email verification card shown in the chat first.');
}

function invalidOrderNumber() {
    return actionRequired('invalid_order_number', 'Please provide a valid order number.');
}

function missingAddressDetails() {
    return actionRequired('missing_address_details', 'Submit the secure billing or shipping address form shown in chat.');
}

function validGuestAccess(access) {
    return Boolean(access?.token && access?.email && access?.sessionId);
}

function validAddressUpdate(args) {
    return Boolean(args.orderNumber && args.addressType && Object.keys(args.address).length > 0);
}
