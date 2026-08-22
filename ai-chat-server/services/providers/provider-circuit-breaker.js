import { formatProviderError } from './provider-error.js';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30000;

/** Small process-local breaker; each gateway replica protects itself. */
export class ProviderCircuitBreaker {
    constructor({ failureThreshold = DEFAULT_FAILURE_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
        this.failureThreshold = Math.max(1, Math.trunc(failureThreshold));
        this.cooldownMs = Math.max(1000, Math.trunc(cooldownMs));
        this.states = new Map();
    }

    beforeRequest(key) {
        const state = this.states.get(String(key));
        if (!state || state.openedAt === 0) return { allowed: true, retryAfterMs: 0 };
        const elapsed = Date.now() - state.openedAt;
        if (elapsed >= this.cooldownMs) {
            state.openedAt = 0;
            state.failures = 0;
            return { allowed: true, retryAfterMs: 0 };
        }
        return { allowed: false, retryAfterMs: Math.max(1000, this.cooldownMs - elapsed) };
    }

    recordSuccess(key) {
        this.states.delete(String(key));
    }

    recordFailure(key) {
        const normalizedKey = String(key);
        const state = this.states.get(normalizedKey) || { failures: 0, openedAt: 0 };
        state.failures += 1;
        if (state.failures >= this.failureThreshold) state.openedAt = Date.now();
        this.states.set(normalizedKey, state);
        return state;
    }

    snapshot() {
        const now = Date.now();
        return [...this.states.entries()].map(([key, state]) => ({
            key,
            state: state.openedAt > 0 && now - state.openedAt < this.cooldownMs ? 'open' : 'closed',
            failures: state.failures,
            retry_after_seconds: state.openedAt > 0
                ? Math.max(0, Math.ceil((this.cooldownMs - (now - state.openedAt)) / 1000))
                : 0
        }));
    }
}

export function createCircuitOpenError(retryAfterMs) {
    const error = new Error('Provider circuit is temporarily open.');
    error.code = 'provider_circuit_open';
    error.status = 503;
    error.retryAfterMs = Math.max(1000, Math.trunc(retryAfterMs || 1000));
    error.publicMessage = formatProviderError(error, 'AI provider');
    return error;
}
