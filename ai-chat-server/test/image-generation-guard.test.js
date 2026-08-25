import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireImageGenerationAdmission } from '../services/media/image-generation-guard.js';

test('applies customer hourly, daily and cooldown limits before starting generation', async () => {
    const calls = [];
    const runtime = {
        async consumeRateLimit(key, options) {
            calls.push({ key, options });
            return { allowed: true, retryAfterMs: 0 };
        },
        async acquireScopedCapacity(namespace, identity, options) {
            calls.push({ namespace, identity, options });
            return { release: async () => {} };
        }
    };

    const admission = await acquireImageGenerationAdmission({
        runtime,
        identity: 'customer:42',
        isCustomer: true,
        config: {
            image_generation: {
                customer_per_hour: 3,
                customer_per_day: 10,
                cooldown_seconds: 60,
                max_concurrent_per_identity: 1,
                timeout_ms: 180000
            }
        }
    });

    assert.equal(admission.allowed, true);
    // Capacity is secured first; the scarce time-window counters are only
    // consumed afterwards so a busy slot cannot burn daily attempts.
    assert.equal(calls[0].namespace, 'image-generation');
    assert.equal(calls[0].options.concurrency, 1);
    assert.equal(calls.filter((call) => call.options?.windowMs).length, 3);
});

test('releases reserved capacity and reports the longest retry when a quota rejects', async () => {
    let released = false;
    const runtime = {
        async consumeRateLimit(key) {
            if (key.endsWith(':day')) return { allowed: false, retryAfterMs: 90000 };
            return { allowed: true, retryAfterMs: 0 };
        },
        async acquireScopedCapacity() {
            return { release: async () => { released = true; } };
        }
    };

    const admission = await acquireImageGenerationAdmission({
        runtime,
        identity: 'guest:abc',
        isCustomer: false,
        config: { image_generation: { guest_per_hour: 2, guest_per_day: 5, cooldown_seconds: 0 } }
    });

    assert.deepEqual(admission, {
        allowed: false,
        reason: 'image_rate_limited',
        retryAfterMs: 90000
    });
    assert.equal(released, true);
});

test('does not burn scarce hourly or daily quota while the identity slot is busy', async () => {
    const quotaKeys = [];
    const runtime = {
        async consumeRateLimit(key) {
            quotaKeys.push(key);
            return { allowed: true, retryAfterMs: 0 };
        },
        async acquireScopedCapacity() {
            return null;
        }
    };

    const admission = await acquireImageGenerationAdmission({
        runtime,
        identity: 'guest:busy',
        isCustomer: false,
        config: { image_generation: { cooldown_seconds: 60 } }
    });

    assert.deepEqual(admission, {
        allowed: false,
        reason: 'image_generation_busy',
        retryAfterMs: 5000
    });
    assert.deepEqual(quotaKeys, []);
});

test('keeps capacity protection without charging the provider Image API quota for a chat SVG fallback', async () => {
    const calls = [];
    const runtime = {
        async consumeRateLimit() {
            calls.push('quota');
            throw new Error('SVG fallback must not consume Image API quota');
        },
        async acquireScopedCapacity(namespace, identity) {
            calls.push({ namespace, identity });
            return { release: async () => {} };
        }
    };

    const admission = await acquireImageGenerationAdmission({
        runtime,
        identity: 'guest:svg',
        isCustomer: false,
        chargeProviderImageQuota: false,
        config: { image_generation: { max_concurrent_per_identity: 1 } }
    });

    assert.equal(admission.allowed, true);
    assert.deepEqual(calls, [{ namespace: 'image-generation', identity: 'guest:svg' }]);
});
