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

test('consumes weighted quota atomically and does not charge a rejected amount', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-weighted-rate' });
    await runtime.connect();

    assert.equal((await runtime.consumeRateLimit('vision', {
        limit: 5,
        amount: 4,
        windowMs: 1000
    })).allowed, true);
    const rejected = await runtime.consumeRateLimit('vision', {
        limit: 5,
        amount: 2,
        windowMs: 1000
    });
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.count, 4);

    const remaining = await runtime.consumeRateLimit('vision', {
        limit: 5,
        amount: 1,
        windowMs: 1000
    });
    assert.equal(remaining.allowed, true);
    assert.equal(remaining.count, 5);
});

test('checks all weighted scopes before charging any of them', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-batch-rate' });
    await runtime.connect();

    const first = await runtime.consumeRateLimitBatch([
        { identity: 'identity', limit: 5, amount: 4, windowMs: 1000 },
        { identity: 'network', limit: 1, amount: 4, windowMs: 1000 }
    ]);
    assert.equal(first.allowed, false);
    assert.equal(first.failedIdentity, 'network');

    const identityAfterReject = await runtime.consumeRateLimit('identity', {
        limit: 5,
        amount: 5,
        windowMs: 1000
    });
    assert.equal(identityAfterReject.allowed, true);
    assert.equal(identityAfterReject.count, 5);
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

test('keeps text and vision capacity pools independent', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'test-capacity-pools' });
    await runtime.connect();
    const vision = await runtime.acquireCapacity('vision-first', {
        namespace: 'vision', concurrency: 1, maxQueue: 1, queueWaitMs: 1000, leaseMs: 1000
    });
    const text = await runtime.acquireCapacity('text-first', {
        namespace: 'text', concurrency: 1, maxQueue: 1, queueWaitMs: 1000, leaseMs: 1000
    });
    assert.deepEqual(await runtime.getCapacityMetrics(), { active: 2, queued: 0 });
    await Promise.all([vision.release(), text.release()]);
});

test('refuses in-memory state unless it is explicitly allowed', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: false, instanceId: 'test-required-redis' });
    await assert.rejects(runtime.connect(), { code: 'REDIS_REQUIRED' });
});

test('refuses in-memory state in production even when the development override is set', async () => {
    const runtime = new GatewayRuntime({
        allowInMemory: true,
        nodeEnv: 'production',
        instanceId: 'test-production-required-redis'
    });
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
