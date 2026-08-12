const DEFAULT_INTERVAL_MS = 8000;

/**
 * Renews the browser's response watchdog while the provider is working but
 * has not produced customer-visible output. An empty status event is invisible
 * in the UI and remains compatible with existing storefront clients.
 */
export function createResponseProgressPulse({ ws, isCancelled = () => false, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    let timer = null;

    const pulse = () => {
        if (isCancelled()) return;
        try {
            ws?.send(JSON.stringify({ type: 'status', content: '' }));
        } catch {
            // Socket cancellation owns transport errors.
        }
    };

    return {
        start() {
            if (timer !== null) return;
            timer = setInterval(pulse, Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
        },

        stop() {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        }
    };
}
