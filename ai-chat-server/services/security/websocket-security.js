function toOrigin(value) {
    try {
        return new URL(String(value || '')).origin.toLowerCase();
    } catch {
        return '';
    }
}

export function configuredWebSocketOrigins(env = process.env) {
    const values = String(env.WS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (env.MAGENTO_API_URL) values.push(env.MAGENTO_API_URL);
    if (env.MAGENTO_HOST) {
        values.push(`https://${env.MAGENTO_HOST}`, `http://${env.MAGENTO_HOST}`);
    }

    return new Set(values.map(toOrigin).filter(Boolean));
}

/**
 * Add Magento store origins learned from a signed configuration push. This
 * keeps every store-view domain dynamic without hardcoding it into Node.
 */
export function addConfiguredWebSocketOrigins(allowedOrigins, snapshot = {}) {
    if (!(allowedOrigins instanceof Set)) return allowedOrigins;

    const stores = snapshot?.stores && typeof snapshot.stores === 'object'
        ? snapshot.stores
        : {};
    for (const config of [snapshot?.default, ...Object.values(stores)]) {
        const origin = toOrigin(config?.magento_base_url);
        if (origin) allowedOrigins.add(origin);
    }

    return allowedOrigins;
}

export function isAllowedWebSocketOrigin(origin, options = {}) {
    const env = options.env || process.env;
    const allowedOrigins = options.allowedOrigins || configuredWebSocketOrigins(env);
    const normalized = toOrigin(origin);
    if (!normalized) {
        return env.NODE_ENV !== 'production' || env.ALLOW_NON_BROWSER_WEBSOCKET === '1';
    }

    return allowedOrigins.has(normalized);
}

export function installWebSocketHeartbeat(wss, intervalMs = 30000) {
    const safeInterval = Math.max(10000, Math.min(Number(intervalMs) || 30000, 120000));
    const timer = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            socket.ping();
        }
    }, safeInterval);
    timer.unref?.();

    wss.on('close', () => clearInterval(timer));
    return timer;
}

function normalizedAddress(req) {
    const trustProxy = process.env.TRUST_PROXY === '1';
    const forwarded = trustProxy ? String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return forwarded || String(req.socket?.remoteAddress || 'unknown');
}

/** Replica-local admission cap applied before ticket verification work. */
export function createWebSocketConnectionAdmission(options = {}) {
    const globalLimit = Math.max(1, Math.min(Number(options.globalLimit ?? process.env.MAX_WS_CONNECTIONS) || 500, 10000));
    const networkLimit = Math.max(1, Math.min(Number(options.networkLimit ?? process.env.MAX_WS_CONNECTIONS_PER_NETWORK) || 20, 1000));
    const counts = new Map();

    return {
        admit(req, currentConnections = 0) {
            const address = normalizedAddress(req);
            const current = counts.get(address) || 0;
            if (currentConnections >= globalLimit) return { allowed: false, reason: 'global_cap' };
            if (current >= networkLimit) return { allowed: false, reason: 'network_cap' };
            counts.set(address, current + 1);
            let released = false;
            return {
                allowed: true,
                address,
                release() {
                    if (released) return;
                    released = true;
                    const next = Math.max(0, (counts.get(address) || 1) - 1);
                    if (next === 0) counts.delete(address);
                    else counts.set(address, next);
                }
            };
        }
    };
}
