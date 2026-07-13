function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

/** Apply rate and capacity controls before provider-cost voice transcription. */
export async function acquireVoiceTranscriptionAdmission({ runtime, identity, config = {} } = {}) {
    if (!runtime || !identity) {
        return { allowed: false, reason: 'voice_identity_unavailable', retryAfterMs: 0 };
    }

    const voice = config.voice && typeof config.voice === 'object' ? config.voice : {};
    const rate = await runtime.consumeRateLimit(`${identity}:voice:minute`, {
        limit: clampInteger(voice.requests_per_minute, 6, 1, 30),
        windowMs: 60 * 1000
    });
    if (!rate.allowed) {
        return { allowed: false, reason: 'voice_rate_limited', retryAfterMs: rate.retryAfterMs };
    }

    const timeoutMs = clampInteger(voice.timeout_ms, 120000, 10000, 180000);
    const capacity = await runtime.acquireScopedCapacity('voice-transcription', identity, {
        concurrency: clampInteger(voice.max_concurrent_per_identity, 1, 1, 2),
        leaseMs: Math.min(300000, timeoutMs + 10000)
    });
    if (!capacity) {
        return { allowed: false, reason: 'voice_busy', retryAfterMs: 3000 };
    }

    return { allowed: true, release: capacity.release };
}
