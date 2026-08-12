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
