import axios from 'axios';

import { listSupportCases, searchStoreKnowledge, subscribeBackInStock } from '../gateway/assistant-service-client.js';
import { normalizeMagentoToolResponse } from '../catalog/catalog-page-loader.js';
import { DEFAULT_CATALOG_PAGE_SIZE, MAX_CATALOG_PAGE_SIZE } from '../catalog/catalog-pagination.js';
import {
    normalizeAddToCartArguments,
    normalizeAvailabilityArguments,
    normalizeRemoveFromCartArguments,
    normalizeSearchArguments
} from '../catalog/catalog-tool-arguments.js';
import { executeCustomerAddressAction } from '../customer/customer-address-client.js';
import { executeCustomerOrderAction } from '../customer/customer-order-client.js';
import { summarizeError } from '../gateway/error-summary.js';
import {
    normalizeCustomerAddressArguments,
    normalizeOrderAddressArguments,
    normalizeOrderDetailsArguments,
    normalizeRecentOrdersArguments
} from '../customer/customer-order-tool-arguments.js';
import { hashKey } from '../gateway/gateway-runtime.js';
import { guestOrderAction } from '../customer/guest-order-client.js';
import { createInternalMagentoRequestConfig } from '../gateway/magento-auth.js';
import {
    catalogRestUrl,
    catalogScopeCacheIdentity,
    catalogScopeRequestParams
} from '../catalog/catalog-scope.js';
import { resolveMagentoBaseUrl } from '../gateway/magento-url.js';

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
        shopperMessage = '',
        catalogScope = null,
        magentoBaseUrl = ''
    } = context;
    const getMagentoUrl = () => resolveMagentoBaseUrl(catalogScope, magentoBaseUrl);

    try {
        switch (name) {
            case 'searchProducts': {
                const params = normalizeSearchArguments(
                    args,
                    MAX_CATALOG_PAGE_SIZE,
                    DEFAULT_CATALOG_PAGE_SIZE,
                    shopperMessage
                );
                Object.assign(params, catalogScopeRequestParams(catalogScope, customerId));
                const url = catalogRestUrl(getMagentoUrl(), 'afd-ai/products/search', catalogScope);
                return cachedMagentoRead(runtime, 'catalog-search', { params, token, catalogScope, customerId }, 60000, async () => {
                    const response = await secureMagentoGet(url, params, magentoOauth);
                    return normalizeMagentoToolResponse(response.data);
                });
            }

            case 'getProductAvailability': {
                const params = normalizeAvailabilityArguments(args);
                Object.assign(params, catalogScopeRequestParams(catalogScope, customerId));
                const url = catalogRestUrl(getMagentoUrl(), 'afd-ai/products/availability', catalogScope);
                return cachedMagentoRead(runtime, 'catalog-availability', { params, token, catalogScope, customerId }, 15000, async () => {
                    const response = await secureMagentoGet(url, params, magentoOauth);
                    return normalizeMagentoToolResponse(response.data);
                });
            }

            case 'compareProducts': {
                const params = {
                    sku1: String(args.sku1 || '').trim().slice(0, 64),
                    sku2: String(args.sku2 || '').trim().slice(0, 64),
                    ...catalogScopeRequestParams(catalogScope, customerId)
                };
                if (!params.sku1 || !params.sku2) {
                    return actionRequired('missing_skus', 'Choose two products to compare.');
                }
                const url = catalogRestUrl(getMagentoUrl(), 'afd-ai/products/compare', catalogScope);
                const response = await secureMagentoGet(url, params, magentoOauth);
                return normalizeMagentoToolResponse(response.data);
            }

            case 'listCategories': {
                const params = catalogScopeRequestParams(catalogScope, customerId);
                const url = catalogRestUrl(getMagentoUrl(), 'afd-ai/categories', catalogScope);
                const response = await secureMagentoGet(url, params, magentoOauth);
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
                return executeCustomerAddressAction(customerId, 'get', {}, catalogScope);

            case 'updateCustomerAddress': {
                const normalized = normalizeCustomerAddressArguments(args);
                if (!normalized.addressType || Object.keys(normalized.address).length === 0) {
                    return actionRequired('missing_address_details', 'Submit the secure address form shown in chat.');
                }
                return executeCustomerAddressAction(customerId, 'update', normalized, catalogScope);
            }

            case 'getRecentOrders':
                return executeCustomerOrderAction(customerId, 'list', normalizeRecentOrdersArguments(args), catalogScope);

            case 'getGuestOrders':
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                return guestOrderAction('list', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    limit: normalizeRecentOrdersArguments(args).limit
                }, catalogScope);

            case 'getGuestOrderDetails': {
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return guestOrderAction('details', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    ...normalized
                }, catalogScope);
            }

            case 'updateGuestOrderAddress': {
                if (!validGuestAccess(guestOrderAccess)) return guestAccessRequired();
                const normalized = normalizeOrderAddressArguments(args);
                if (!validAddressUpdate(normalized)) return missingAddressDetails();
                return guestOrderAction('update_address', guestOrderAccess.sessionId, {
                    accessToken: guestOrderAccess.token,
                    email: guestOrderAccess.email,
                    ...normalized
                }, catalogScope);
            }

            case 'getOrderDetails':
            case 'getOrderFulfillment': {
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return executeCustomerOrderAction(
                    customerId,
                    name === 'getOrderFulfillment' ? 'fulfillment' : 'details',
                    normalized,
                    catalogScope
                );
            }

            case 'updateOrderAddress': {
                const normalized = normalizeOrderAddressArguments(args);
                if (!validAddressUpdate(normalized)) return missingAddressDetails();
                return executeCustomerOrderAction(customerId, 'update_address', normalized, catalogScope);
            }

            case 'cancelOrder': {
                const normalized = normalizeOrderDetailsArguments(args);
                if (!normalized.orderNumber) return invalidOrderNumber();
                return executeCustomerOrderAction(customerId, 'cancel', {
                    ...normalized,
                    confirmed: args.confirmed === true
                }, catalogScope);
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
                }, catalogScope);
            }

            case 'searchStoreKnowledge':
                return searchStoreKnowledge(args.query, args.limit, catalogScope);

            case 'handoffToHuman':
                if (!supportEmailAccess?.email || !supportEmailAccess?.token || !supportEmailAccess?.sessionId) {
                    return { ...guestAccessRequired(), purpose: 'support', message: 'Verify your email before starting human support.' };
                }
                return listSupportCases({
                    customerId,
                    guestId,
                    verifiedEmail: supportEmailAccess.email,
                    verificationToken: supportEmailAccess.token,
                    verificationSessionId: supportEmailAccess.sessionId,
                    catalogScope
                }, catalogScope);

            case 'subscribeBackInStock':
                return subscribeBackInStock(customerId, args.sku, catalogScope);

            case 'getActiveCoupons': {
                const params = catalogScopeRequestParams(catalogScope, customerId);
                const url = catalogRestUrl(getMagentoUrl(), 'afd-ai/coupons', catalogScope);
                const response = await secureMagentoGet(url, params, magentoOauth);
                return normalizeMagentoToolResponse(response.data);
            }

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

async function cachedMagentoRead(runtime, namespace, identity, ttlMs, loader) {
    // A logged-in shopper can change group or be disabled between WebSocket
    // messages. Do not serve an old catalogue cache entry before Magento has
    // revalidated that customer's live group.
    if (Number(identity.customerId) > 0) return loader();
    if (!runtime || typeof runtime.getOrSetJsonCache !== 'function') return loader();
    const scope = {
        shopper: identity.token ? `customer:${hashKey(identity.token)}` : 'guest',
        catalog: catalogScopeCacheIdentity(identity.catalogScope),
        catalog_version: await runtime.getCacheVersion?.('catalog') || 0
    };
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

async function secureMagentoGet(url, params, magentoOauth) {
    const requestUrl = appendQuery(url, params);
    // Catalogue routes are service-to-service endpoints. Their Magento
    // implementation verifies this HMAC before returning data, so attaching
    // an OAuth header as well is both redundant and harmful: Magento chooses
    // the OAuth identity first and rejects a valid internal request when an
    // integration lacks this module's private ACL resource.
    const internal = createInternalMagentoRequestConfig('GET', requestUrl, '', { timeout: 20000 });

    return axios.get(requestUrl, {
        ...internal,
        headers: internal.headers
    });
}

function appendQuery(url, params = {}) {
    const requestUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        requestUrl.searchParams.set(key, String(value));
    }
    return requestUrl.toString();
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
