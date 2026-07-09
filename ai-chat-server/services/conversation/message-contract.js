export const GATEWAY_CONTRACT_VERSION = 1;

export function encodeGatewayEvent(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('Gateway events must be JSON objects.');
    }
    return JSON.stringify({
        contract_version: GATEWAY_CONTRACT_VERSION,
        ...payload
    });
}

/**
 * Compatibility boundary for the existing WebSocket handlers. It versions
 * every JSON event without forcing transport concerns into application code.
 */
export function installGatewayEventContract(socket) {
    const nativeSend = socket.send.bind(socket);
    socket.send = (value, ...args) => {
        if (typeof value !== 'string') {
            return nativeSend(value, ...args);
        }
        try {
            const payload = JSON.parse(value);
            return nativeSend(encodeGatewayEvent(payload), ...args);
        } catch {
            return nativeSend(value, ...args);
        }
    };
    return socket;
}

export function acceptsClientContract(payload) {
    const version = Number(payload?.contract_version || GATEWAY_CONTRACT_VERSION);
    return Number.isInteger(version) && version === GATEWAY_CONTRACT_VERSION;
}
