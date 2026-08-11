import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireImageGenerationAdmission } from '../services/image-generation-guard.js';

test('applies customer hourly, daily and cooldown limits before acquiring capacity', async () => {
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
    assert.equal(calls.filter((call) => call.options?.windowMs).length, 3);
    assert.equal(calls.at(-1).namespace, 'image-generation');
    assert.equal(calls.at(-1).options.concurrency, 1);
});

test('returns the longest retry interval when an image quota is exhausted', async () => {
    const runtime = {
        async consumeRateLimit(key) {
            if (key.endsWith(':day')) return { allowed: false, retryAfterMs: 90000 };
            return { allowed: true, retryAfterMs: 0 };
        },
        async acquireScopedCapacity() {
            throw new Error('capacity must not be acquired after quota rejection');
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
});
