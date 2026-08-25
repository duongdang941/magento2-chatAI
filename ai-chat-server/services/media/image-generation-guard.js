function readLimit(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

/**
 * Apply provider-cost controls before starting an image request. All keys use
 * the shared gateway runtime, so limits remain effective across Node replicas.
 */
export async function acquireImageGenerationAdmission({
    runtime,
    identity,
    isCustomer,
    config = {},
    chargeProviderImageQuota = true
} = {}) {
    if (!runtime || !identity) {
        return { allowed: false, reason: 'image_identity_unavailable', retryAfterMs: 0 };
    }

    const imageConfig = config.image_generation || {};
    const hourlyLimit = isCustomer
        ? readLimit(imageConfig.customer_per_hour, 3, 1, 100)
        : readLimit(imageConfig.guest_per_hour, 2, 1, 50);
    const dailyLimit = isCustomer
        ? readLimit(imageConfig.customer_per_day, 10, 1, 500)
        : readLimit(imageConfig.guest_per_day, 5, 1, 200);
    const cooldownSeconds = readLimit(imageConfig.cooldown_seconds, 60, 0, 3600);
    // Capacity is secured before any scarce time-window counter is consumed
    // so a busy slot (`image_generation_busy`) never burns hourly/daily quota.
    const timeoutMs = readLimit(imageConfig.timeout_ms, 180000, 30000, 300000);
    const capacity = await runtime.acquireScopedCapacity('image-generation', identity, {
        concurrency: readLimit(imageConfig.max_concurrent_per_identity, 1, 1, 3),
        leaseMs: Math.min(600000, timeoutMs + 10000)
    });
    if (!capacity) {
        return {
            allowed: false,
            reason: 'image_generation_busy',
            retryAfterMs: 5000
        };
    }

    if (chargeProviderImageQuota) {
        try {
            const checks = [
                runtime.consumeRateLimit(`${identity}:image:hour`, {
                    limit: hourlyLimit,
                    windowMs: 60 * 60 * 1000
                }),
                runtime.consumeRateLimit(`${identity}:image:day`, {
                    limit: dailyLimit,
                    windowMs: 24 * 60 * 60 * 1000
                })
            ];
            if (cooldownSeconds > 0) {
                checks.push(runtime.consumeRateLimit(`${identity}:image:cooldown`, {
                    limit: 1,
                    windowMs: cooldownSeconds * 1000
                }));
            }

            const results = await Promise.all(checks);
            const denied = results.filter((result) => !result.allowed);
            if (denied.length > 0) {
                await capacity.release?.();
                return {
                    allowed: false,
                    reason: 'image_rate_limited',
                    retryAfterMs: Math.max(...denied.map((result) => Number(result.retryAfterMs) || 0))
                };
            }
        } catch (error) {
            await capacity.release?.();
            throw error;
        }
    }

    return { allowed: true, release: capacity.release };
}
