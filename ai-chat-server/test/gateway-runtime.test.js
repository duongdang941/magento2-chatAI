import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayRuntime } from '../services/gateway/gateway-runtime.js';

test('rate limits a shared identity', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-rate' });
    await runtime.connect();

    assert.equal((await runtime.consumeRateLimit('customer:7', { limit: 2, windowMs: 1000 })).allowed, true);
    assert.equal((await runtime.consumeRateLimit('customer:7', { limit: 2, windowMs: 1000 })).allowed, true);
    const blocked = await runtime.consumeRateLimit('customer:7', { limit: 2, windowMs: 1000 });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
});

test('allows only one state-changing action lock for the same identity', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-lock' });
    await runtime.connect();

    const first = await runtime.acquireActionLock('address-update', 'customer:7', 1000);
    assert.ok(first);
    assert.equal(await runtime.acquireActionLock('address-update', 'customer:7', 1000), null);
    assert.ok(await runtime.acquireActionLock('address-update', 'customer:8', 1000));
    await first.release();
    assert.ok(await runtime.acquireActionLock('address-update', 'customer:7', 1000));
});

test('bounds and releases scoped image-generation capacity', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-scoped-capacity' });
    await runtime.connect();

    const first = await runtime.acquireScopedCapacity('image-generation', 'customer:7', {
        concurrency: 1,
        leaseMs: 10000
    });
    const blocked = await runtime.acquireScopedCapacity('image-generation', 'customer:7', {
        concurrency: 1,
        leaseMs: 10000
    });

    assert.ok(first);
    assert.equal(blocked, null);
    await first.release();
    assert.ok(await runtime.acquireScopedCapacity('image-generation', 'customer:7', {
        concurrency: 1,
        leaseMs: 10000
    }));
});

test('queues a request until the global concurrency lease is released', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-capacity' });
    await runtime.connect();

    const first = await runtime.acquireCapacity('first', {
        concurrency: 1,
        maxQueue: 2,
        queueWaitMs: 1000,
        leaseMs: 1000,
        pollMs: 25
    });
    const secondPromise = runtime.acquireCapacity('second', {
        concurrency: 1,
        maxQueue: 2,
        queueWaitMs: 1000,
        leaseMs: 1000,
        pollMs: 25
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await runtime.getCapacityMetrics()).queued, 1);
    await first.release();

    const second = await secondPromise;
    assert.ok(second.queueWaitMs >= 25);
    await second.release();
    assert.deepEqual(await runtime.getCapacityMetrics(), { active: 0, queued: 0 });
});

test('refuses in-memory state unless it is explicitly allowed', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: false, instanceId: 'test-required-redis' });
    await assert.rejects(runtime.connect(), { code: 'REDIS_REQUIRED' });
});

test('claims each WebSocket ticket only once', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-ticket' });
    await runtime.connect();

    assert.equal(await runtime.claimWebSocketTicket('ticket-1', 60), true);
    assert.equal(await runtime.claimWebSocketTicket('ticket-1', 60), false);
});

test('claims configuration sync identifiers only once', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-config-sync' });
    await runtime.connect();

    assert.equal(await runtime.claimOnce('config-sync', 'a'.repeat(32), 1000), true);
    assert.equal(await runtime.claimOnce('config-sync', 'a'.repeat(32), 1000), false);
    assert.equal(await runtime.claimOnce('config-sync', 'b'.repeat(32), 1000), true);
});

test('coalesces simultaneous catalog cache misses and caches the result', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-catalog-cache' });
    await runtime.connect();
    let loads = 0;
    const loader = async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { data: ['juno jacket'] };
    };

    const [first, second] = await Promise.all([
        runtime.getOrSetJsonCache('catalog-search', 'store:1:jacket', { ttlMs: 1000 }, loader),
        runtime.getOrSetJsonCache('catalog-search', 'store:1:jacket', { ttlMs: 1000 }, loader)
    ]);

    assert.equal(loads, 1);
    assert.deepEqual(first.value, { data: ['juno jacket'] });
    assert.deepEqual(second.value, { data: ['juno jacket'] });

    const third = await runtime.getOrSetJsonCache('catalog-search', 'store:1:jacket', { ttlMs: 1000 }, loader);
    assert.equal(third.cacheHit, true);
    assert.equal(loads, 1);
});

test('keeps guest-order access scoped to one shared session identity', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-guest-access' });
    await runtime.connect();

    await runtime.setAuthCache('guest-order-access:session-a', {
        email: 'chienthannd10+test@gmail.com',
        accessToken: 'a'.repeat(64),
        expiresAt: Date.now() + 900000
    }, 900000);

    assert.equal(
        (await runtime.getAuthCache('guest-order-access:session-a')).accessToken,
        'a'.repeat(64)
    );
    assert.equal(await runtime.getAuthCache('guest-order-access:session-b'), null);
});
