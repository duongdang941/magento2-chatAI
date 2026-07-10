import crypto from 'crypto';

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Coordinates a cart mutation with the browser that owns the storefront
 * session. The gateway deliberately does not replay the browser cookie: a
 * server-side HTTP request can create a different Magento session, which
 * makes a successful tool result invisible in the shopper's cart.
 */
export class BrowserCartBridge {
    constructor({ isSocketOpen, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.isSocketOpen = typeof isSocketOpen === 'function' ? isSocketOpen : () => false;
        this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
        this.pendingRequests = new WeakMap();
    }

    request(ws, { requestId, cart, signal } = {}) {
        if (!ws || !this.isSocketOpen(ws)) {
            return Promise.resolve(this.failure('The storefront connection is unavailable. Please try again.'));
        }

        const cartRequestId = crypto.randomUUID();
        const payload = this.normalizeCart(cart);
        if (!payload.sku) {
            return Promise.resolve(this.failure('A product could not be selected.'));
        }

        return new Promise((resolve) => {
            const requests = this.requestsFor(ws);
            let settled = false;
            let timeout = null;

            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                signal?.removeEventListener?.('abort', onAbort);
                requests.delete(cartRequestId);
                resolve(this.normalizeResult(result));
            };

            const onAbort = () => finish(this.failure('The cart action was cancelled.'));
            timeout = setTimeout(() => {
                finish(this.failure('The cart did not respond in time. Please try again.'));
            }, this.timeoutMs);
            signal?.addEventListener?.('abort', onAbort, { once: true });

            requests.set(cartRequestId, { requestId: String(requestId || ''), finish });
            try {
                ws.send(JSON.stringify({
                    type: payload.action === 'remove' ? 'cart_remove_request' : 'cart_add_request',
                    request_id: String(requestId || ''),
                    cart_request_id: cartRequestId,
                    cart: payload
                }));
            } catch (error) {
                finish(this.failure('The storefront connection is unavailable. Please try again.'));
            }
        });
    }

    resolve(ws, data = {}) {
        const cartRequestId = String(data.cart_request_id || '');
        const request = this.requestsFor(ws).get(cartRequestId);
        if (!request || (request.requestId && String(data.request_id || '') !== request.requestId)) {
            return false;
        }

        request.finish(this.normalizeResult(data.result));
        return true;
    }

    rejectAll(ws, message = 'The storefront connection was closed before the cart could be updated.') {
        const requests = this.pendingRequests.get(ws);
        if (!requests) return;
        [...requests.values()].forEach((request) => request.finish(this.failure(message)));
        this.pendingRequests.delete(ws);
    }

    requestsFor(ws) {
        let requests = this.pendingRequests.get(ws);
        if (!requests) {
            requests = new Map();
            this.pendingRequests.set(ws, requests);
        }
        return requests;
    }

    normalizeCart(cart) {
        const input = cart && typeof cart === 'object' ? cart : {};
        const selectedOptions = {};
        if (input.selectedOptions && typeof input.selectedOptions === 'object' && !Array.isArray(input.selectedOptions)) {
            Object.entries(input.selectedOptions).slice(0, 8).forEach(([code, value]) => {
                const key = String(code || '').trim();
                const label = String(value || '').trim();
                if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && label && label.length <= 120) {
                    selectedOptions[key] = label;
                }
            });
        }

        return {
            action: String(input.action || '').trim().toLowerCase() === 'remove' ? 'remove' : 'add',
            sku: String(input.sku || '').trim().slice(0, 128),
            qty: Math.max(1, Math.min(1000000, Math.trunc(Number(input.qty) || 1))),
            ...(input.useDefaultQty === true ? { useDefaultQty: true } : {}),
            cartTarget: String(input.cartTarget || '').trim().toLowerCase() === 'quote'
                ? 'quote'
                : 'checkout',
            selectedOptions
        };
    }

    normalizeResult(result) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return this.failure('The cart returned an invalid response. Please try again.');
        }

        const status = String(result.status || '').toLowerCase();
        if (!['success', 'error', 'requires_customer_action'].includes(status)) {
            return this.failure('The cart could not confirm this change. Please try again.');
        }

        return result;
    }

    failure(message) {
        return { status: 'error', message };
    }
}
