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

export function webSocketNetworkIdentity(req, environment = process.env) {
    const trustProxy = environment.TRUST_PROXY === '1';
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
            const address = webSocketNetworkIdentity(req);
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

/** Apply replica-local admission and origin validation before ticket work. */
export function admitLocalWebSocketConnection(socket, request, options = {}) {
    const admission = options.admission?.admit(request, options.currentConnections || 0);
    if (!admission?.allowed) {
        options.metrics?.increment('websocket_rejected', { reason: admission?.reason || 'local_cap' });
        socket.close(1013, 'Chat connection capacity is temporarily full');
        return false;
    }
    socket.once('close', admission.release);
    if (!isAllowedWebSocketOrigin(request.headers?.origin, { allowedOrigins: options.allowedOrigins })) {
        options.metrics?.increment('websocket_rejected', { reason: 'invalid_origin' });
        socket.close(1008, 'Origin is not allowed');
        return false;
    }
    return true;
}

/**
 * Shared Redis-backed admission for WebSocket connections. The local cap above
 * remains a cheap pre-filter, while this lease is authoritative across Node
 * replicas. A lease is renewed by the connection lifecycle and expires if a
 * process dies before its socket close handler runs.
 */
export function createDistributedWebSocketConnectionAdmission(options = {}) {
    const runtime = options.runtime;
    const environment = options.env || process.env;
    const globalLimit = Math.max(1, Math.min(Number(options.globalLimit ?? environment.MAX_WS_CONNECTIONS) || 500, 10000));
    const networkLimit = Math.max(1, Math.min(Number(options.networkLimit ?? environment.MAX_WS_CONNECTIONS_PER_NETWORK) || 20, 1000));
    const leaseMs = Math.max(30000, Math.min(Number(options.leaseMs ?? environment.WS_CONNECTION_LEASE_MS) || 90000, 600000));

    if (!runtime || typeof runtime.acquireScopedCapacity !== 'function') {
        throw new Error('A shared gateway runtime is required for distributed WebSocket admission.');
    }

    return {
        leaseMs,
        async admit(req) {
            const address = webSocketNetworkIdentity(req, environment);
            const global = await runtime.acquireScopedCapacity('websocket-global', 'all', {
                concurrency: globalLimit,
                leaseMs
            });
            if (!global) return { allowed: false, reason: 'global_cap' };

            try {
                const network = await runtime.acquireScopedCapacity('websocket-network', address, {
                    concurrency: networkLimit,
                    leaseMs
                });
                if (!network) {
                    await global.release();
                    return { allowed: false, reason: 'network_cap' };
                }
                return {
                    allowed: true,
                    address,
                    async renew() {
                        const renewed = await Promise.all([global.renew(), network.renew()]);
                        return renewed.every(Boolean);
                    },
                    async release() {
                        await Promise.allSettled([global.release(), network.release()]);
                    }
                };
            } catch (error) {
                await global.release();
                throw error;
            }
        }
    };
}

/** Keep a shared WebSocket lease alive and release it when the socket closes. */
export function installDistributedWebSocketLease(socket, admission, options = {}) {
    const metrics = options.metrics;
    const renewalMs = Math.max(10000, Math.floor(Number(options.leaseMs) / 3) || 30000);
    let renewing = false;
    const timer = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try {
            if (!await admission.renew()) {
                metrics?.increment('websocket_rejected', { reason: 'shared_lease_lost' });
                socket.close(1013, 'Chat connection capacity lease expired');
            }
        } catch {
            metrics?.increment('websocket_rejected', { reason: 'shared_lease_unavailable' });
            socket.close(1013, 'Chat connection capacity is temporarily unavailable');
        } finally {
            renewing = false;
        }
    }, renewalMs);
    timer.unref?.();
    socket.once('close', () => {
        clearInterval(timer);
        admission.release().catch(() => {});
    });
    return timer;
}

/** Acquire, install and expose the result of distributed WebSocket admission. */
export async function admitDistributedWebSocketConnection(socket, request, admission, metrics) {
    let connection;
    try {
        connection = await admission.admit(request);
    } catch {
        metrics?.increment('websocket_rejected', { reason: 'shared_admission_unavailable' });
        socket.close(1013, 'Chat connection capacity is temporarily unavailable');
        return false;
    }
    if (!connection.allowed) {
        metrics?.increment('websocket_rejected', { reason: connection.reason });
        socket.close(1013, 'Chat connection capacity is temporarily full');
        return false;
    }
    installDistributedWebSocketLease(socket, connection, { metrics, leaseMs: admission.leaseMs });
    return true;
}
