import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GatewayRuntime } from '../services/gateway/gateway-runtime.js';

/**
 * Opt-in integration check for a real Redis server. It is intentionally not
 * part of `npm test`, because local unit tests must not require infrastructure.
 * Run with REDIS_URL set in CI/staging.
 */
const redisUrl = String(process.env.REDIS_URL || '').trim();
if (!redisUrl) {
    console.log('SKIP: set REDIS_URL to run the real Redis integration test.');
    process.exit(0);
}

const runtime = new GatewayRuntime({
    redisUrl,
    allowInMemory: false,
    instanceId: `redis-integration-${crypto.randomUUID()}`
});
const identity = `redis-integration:${crypto.randomUUID()}`;

try {
    await runtime.connect();
    const results = await Promise.all(Array.from({ length: 20 }, () => runtime.consumeRateLimitBatch([
        { identity, limit: 5, windowMs: 60_000, amount: 1 }
    ])));
    const allowed = results.filter(result => result.allowed).length;
    assert.equal(allowed, 5, 'Redis must atomically allow only five concurrent claims');
    assert.equal(results.length, 20);
    console.log('PASS: Redis atomic rate-limit integration (5/20 allowed).');
} finally {
    await runtime.disconnect();
}
