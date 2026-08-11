import crypto from 'node:crypto';
import Redis from 'ioredis';

const PREFIX = 'afd:ai:gateway';
const MAX_AUTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

const QUEUE_REGISTER_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], 'NX', ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const SEMAPHORE_ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

const SEMAPHORE_RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[2]) == false then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const CACHE_UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

function numberFromEnv(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        if (!signal) return;

        const abort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Admission cancelled.'), { code: 'ABORTED' }));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
    });
}

function hashKey(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function runtimeError(code, message, details = {}) {
    return Object.assign(new Error(message), { code, ...details });
}

/**
 * Shared state for all Node gateway replicas. Redis is mandatory in a
 * production process; the memory implementation is intentionally opt-in and
 * exists only for tests and a single-process local development session.
 */
export class GatewayRuntime {
    constructor(options = {}) {
        this.redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? '';
        this.allowInMemory = options.allowInMemory
            ?? (process.env.ALLOW_IN_MEMORY_STATE === 'true' || process.env.NODE_ENV === 'test');
        this.instanceId = options.instanceId || process.env.GATEWAY_INSTANCE_ID || crypto.randomUUID();
        this.redis = options.redis || null;
        this.mode = this.redis || this.redisUrl ? 'redis' : 'memory';
        this.connected = false;
        this.memoryRateLimits = new Map();
        this.memoryQueue = new Map();
        this.memorySemaphore = new Map();
        this.memoryCache = new Map();
        this.memorySingleFlight = new Map();
        this.memoryLocks = new Map();
        this.memoryConfig = null;
    }

    async connect() {
        if (this.connected) return;

        if (this.mode === 'memory') {
            if (!this.allowInMemory) {
                throw runtimeError(
                    'REDIS_REQUIRED',
                    'REDIS_URL is required. Set ALLOW_IN_MEMORY_STATE=true only for local development or tests.'
                );
            }
            this.connected = true;
            return;
        }

        if (!this.redis) {
            this.redis = new Redis(this.redisUrl, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableReadyCheck: true,
                connectTimeout: numberFromEnv(process.env.REDIS_CONNECT_TIMEOUT_MS, 3000, 500, 30000),
                retryStrategy: (attempt) => Math.min(250 * attempt, 2000)
            });
        }

        try {
            if (this.redis.status === 'wait') await this.redis.connect();
            await this.redis.ping();
            this.connected = true;
        } catch (error) {
            await this.redis.quit().catch(() => this.redis.disconnect());
            throw runtimeError('REDIS_UNAVAILABLE', 'The shared Redis gateway state is unavailable.', {
                cause: error
            });
        }
    }

    async disconnect() {
        this.connected = false;
        if (this.mode === 'redis' && this.redis) {
            await this.redis.quit().catch(() => this.redis.disconnect());
        }
    }

    getHealth() {
        return {
            mode: this.mode,
            connected: this.connected,
            instance_id: this.instanceId
        };
    }

    async consumeRateLimit(identity, { limit, windowMs }) {
        const key = `${PREFIX}:rate:${hashKey(identity)}`;
        const safeLimit = numberFromEnv(limit, 15, 1, 10000);
        const safeWindow = numberFromEnv(windowMs, 60000, 1000, 3600000);

        if (this.mode === 'redis') {
            const [count, ttl] = await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, safeWindow);
            return {
                allowed: Number(count) <= safeLimit,
                count: Number(count),
                retryAfterMs: Math.max(0, Number(ttl))
            };
        }

        const now = Date.now();
        const record = this.memoryRateLimits.get(key) || { count: 0, expiresAt: now + safeWindow };
        if (record.expiresAt <= now) {
            record.count = 0;
            record.expiresAt = now + safeWindow;
        }
        record.count += 1;
        this.memoryRateLimits.set(key, record);
        return {
            allowed: record.count <= safeLimit,
            count: record.count,
            retryAfterMs: Math.max(0, record.expiresAt - now)
        };
    }

    /** Acquire a short distributed lock for a state-changing customer action. */
    async acquireActionLock(namespace, identity, ttlMs = 20000) {
        const safeTtl = numberFromEnv(ttlMs, 20000, 1000, 60000);
        const key = `${PREFIX}:lock:${String(namespace || 'action').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 80)}:${hashKey(identity)}`;
        const token = `${this.instanceId}:${crypto.randomUUID()}`;

        if (this.mode === 'redis') {
            const result = await this.redis.set(key, token, 'PX', safeTtl, 'NX');
            if (result !== 'OK') return null;
            return {
                token,
                release: () => this.redis.eval(CACHE_UNLOCK_SCRIPT, 1, key, token).catch(() => 0)
            };
        }

        const current = this.memoryLocks.get(key);
        if (current && current.expiresAt > Date.now()) return null;
        this.memoryLocks.set(key, { token, expiresAt: Date.now() + safeTtl });
        return {
            token,
            release: async () => {
                if (this.memoryLocks.get(key)?.token === token) this.memoryLocks.delete(key);
            }
        };
    }

    /** Acquire a bounded shared semaphore for one logical shopper/action. */
    async acquireScopedCapacity(namespace, identity, options = {}) {
        const concurrency = numberFromEnv(options.concurrency, 1, 1, 100);
        const leaseMs = numberFromEnv(options.leaseMs, 180000, 1000, 600000);
        const safeNamespace = String(namespace || 'capacity').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 80);
        const key = `${PREFIX}:scoped:${safeNamespace}:${hashKey(identity)}`;
        const token = `${this.instanceId}:${crypto.randomUUID()}`;
        const now = Date.now();

        if (this.mode === 'redis') {
            const acquired = await this.redis.eval(
                SEMAPHORE_ACQUIRE_SCRIPT,
                1,
                key,
                now,
                concurrency,
                now + leaseMs,
                token,
                leaseMs
            );
            if (Number(acquired) !== 1) return null;
            return {
                token,
                release: () => this.redis.zrem(key, token).catch(() => 0)
            };
        }

        const current = this.memorySemaphore.get(key) || new Map();
        for (const [entryToken, expiresAt] of current.entries()) {
            if (expiresAt <= now) current.delete(entryToken);
        }
        if (current.size >= concurrency) return null;
        current.set(token, now + leaseMs);
        this.memorySemaphore.set(key, current);
        return {
            token,
            release: async () => {
                const entries = this.memorySemaphore.get(key);
                entries?.delete(token);
                if (entries?.size === 0) this.memorySemaphore.delete(key);
            }
        };
    }

    async acquireCapacity(requestId, options = {}) {
        const concurrency = numberFromEnv(options.concurrency, 32, 1, 10000);
        const maxQueue = numberFromEnv(options.maxQueue, 200, 0, 100000);
        const queueWaitMs = numberFromEnv(options.queueWaitMs, 30000, 1000, 300000);
        const leaseMs = numberFromEnv(options.leaseMs, 90000, 10000, 600000);
        const pollMs = numberFromEnv(options.pollMs, 100, 25, 2000);
        const token = `${this.instanceId}:${requestId}:${crypto.randomUUID()}`;
        const startedAt = Date.now();

        if (this.mode === 'redis') {
            const queueKey = `${PREFIX}:queue:model`;
            const semaphoreKey = `${PREFIX}:semaphore:model`;
            const accepted = await this.redis.eval(
                QUEUE_REGISTER_SCRIPT,
                1,
                queueKey,
                startedAt - queueWaitMs,
                maxQueue,
                startedAt,
                token,
                queueWaitMs + 5000
            );
            if (Number(accepted) !== 1) {
                throw runtimeError('QUEUE_FULL', 'The AI gateway queue is full.', { retryAfterMs: pollMs });
            }

            try {
                while (Date.now() - startedAt < queueWaitMs) {
                    if (options.signal?.aborted) throw runtimeError('ABORTED', 'Admission cancelled.');
                    const rank = await this.redis.zrank(queueKey, token);
                    if (rank === null) {
                        throw runtimeError('QUEUE_EXPIRED', 'The AI gateway queue entry expired.', { retryAfterMs: pollMs });
                    }
                    if (Number(rank) === 0) {
                        const now = Date.now();
                        const acquired = await this.redis.eval(
                            SEMAPHORE_ACQUIRE_SCRIPT,
                            1,
                            semaphoreKey,
                            now,
                            concurrency,
                            now + leaseMs,
                            token,
                            leaseMs
                        );
                        if (Number(acquired) === 1) {
                            await this.redis.zrem(queueKey, token);
                            return {
                                token,
                                queueWaitMs: Date.now() - startedAt,
                                leaseMs,
                                release: () => this.releaseCapacity(token),
                                renew: () => this.renewCapacity(token, leaseMs)
                            };
                        }
                    }
                    await sleep(pollMs, options.signal);
                }
                throw runtimeError('QUEUE_TIMEOUT', 'The AI gateway remained busy for too long.', { retryAfterMs: pollMs });
            } finally {
                await this.redis.zrem(queueKey, token).catch(() => {});
            }
        }

        return this.acquireMemoryCapacity(token, {
            concurrency,
            maxQueue,
            queueWaitMs,
            leaseMs,
            pollMs,
            signal: options.signal,
            startedAt
        });
    }

    async acquireMemoryCapacity(token, options) {
        const { concurrency, maxQueue, queueWaitMs, leaseMs, pollMs, signal, startedAt } = options;
        const cleanup = () => {
            const now = Date.now();
            for (const [key, expiry] of this.memorySemaphore.entries()) {
                if (expiry <= now) this.memorySemaphore.delete(key);
            }
            for (const [key, queuedAt] of this.memoryQueue.entries()) {
                if (now - queuedAt > queueWaitMs) this.memoryQueue.delete(key);
            }
        };

        cleanup();
        if (this.memoryQueue.size >= maxQueue) {
            throw runtimeError('QUEUE_FULL', 'The AI gateway queue is full.', { retryAfterMs: pollMs });
        }
        this.memoryQueue.set(token, startedAt);
        try {
            while (Date.now() - startedAt < queueWaitMs) {
                if (signal?.aborted) throw runtimeError('ABORTED', 'Admission cancelled.');
                cleanup();
                const first = this.memoryQueue.keys().next().value;
                if (first === token && this.memorySemaphore.size < concurrency) {
                    this.memoryQueue.delete(token);
                    this.memorySemaphore.set(token, Date.now() + leaseMs);
                    return {
                        token,
                        queueWaitMs: Date.now() - startedAt,
                        leaseMs,
                        release: () => this.releaseCapacity(token),
                        renew: () => this.renewCapacity(token, leaseMs)
                    };
                }
                await sleep(pollMs, signal);
            }
            throw runtimeError('QUEUE_TIMEOUT', 'The AI gateway remained busy for too long.', { retryAfterMs: pollMs });
        } finally {
            this.memoryQueue.delete(token);
        }
    }

    async renewCapacity(token, leaseMs) {
        const safeLease = numberFromEnv(leaseMs, 90000, 10000, 600000);
        if (this.mode === 'redis') {
            const result = await this.redis.eval(
                SEMAPHORE_RENEW_SCRIPT,
                1,
                `${PREFIX}:semaphore:model`,
                Date.now() + safeLease,
                token,
                safeLease
            );
            return Number(result) === 1;
        }
        if (!this.memorySemaphore.has(token)) return false;
        this.memorySemaphore.set(token, Date.now() + safeLease);
        return true;
    }

    async releaseCapacity(token) {
        if (this.mode === 'redis') {
            await this.redis.zrem(`${PREFIX}:semaphore:model`, token);
            return;
        }
        this.memorySemaphore.delete(token);
    }

    async getCapacityMetrics() {
        if (this.mode === 'redis') {
            const now = Date.now();
            await this.redis.zremrangebyscore(`${PREFIX}:semaphore:model`, '-inf', now);
            await this.redis.zremrangebyscore(`${PREFIX}:queue:model`, '-inf', now - 300000);
            const [active, queued] = await Promise.all([
                this.redis.zcard(`${PREFIX}:semaphore:model`),
                this.redis.zcard(`${PREFIX}:queue:model`)
            ]);
            return { active: Number(active), queued: Number(queued) };
        }
        const now = Date.now();
        for (const [key, expiry] of this.memorySemaphore.entries()) {
            if (expiry <= now) this.memorySemaphore.delete(key);
        }
        return { active: this.memorySemaphore.size, queued: this.memoryQueue.size };
    }

    async getAuthCache(key) {
        const namespacedKey = `${PREFIX}:auth:${hashKey(key)}`;
        if (this.mode === 'redis') {
            const value = await this.redis.get(namespacedKey);
            if (!value) return null;
            try { return JSON.parse(value); } catch { return null; }
        }
        const value = this.memoryCache.get(namespacedKey);
        if (!value || value.expiresAt <= Date.now()) {
            this.memoryCache.delete(namespacedKey);
            return null;
        }
        return value.value;
    }

    async setAuthCache(key, value, ttlMs) {
        const namespacedKey = `${PREFIX}:auth:${hashKey(key)}`;
        const safeTtl = numberFromEnv(ttlMs, 60000, 1000, MAX_AUTH_CACHE_TTL_MS);
        if (this.mode === 'redis') {
            await this.redis.set(namespacedKey, JSON.stringify(value), 'PX', safeTtl);
            return;
        }
        this.memoryCache.set(namespacedKey, { value, expiresAt: Date.now() + safeTtl });
    }

    async deleteAuthCache(key) {
        const namespacedKey = `${PREFIX}:auth:${hashKey(key)}`;
        if (this.mode === 'redis') {
            await this.redis.del(namespacedKey);
            return;
        }
        this.memoryCache.delete(namespacedKey);
    }

    async getGuestSessionHistory(guestId) {
        const key = `${PREFIX}:guest-session:${hashKey(guestId)}`;
        if (this.mode === 'redis') {
            const raw = await this.redis.get(key);
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { await this.redis.del(key); return null; }
        }
        const entry = this.memoryCache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
            this.memoryCache.delete(key);
            return null;
        }
        return entry.value;
    }

    async setGuestSessionHistory(guestId, value, ttlMs) {
        const key = `${PREFIX}:guest-session:${hashKey(guestId)}`;
        const safeTtl = numberFromEnv(ttlMs, 8 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
        if (this.mode === 'redis') {
            await this.redis.set(key, JSON.stringify(value), 'PX', safeTtl);
            return;
        }
        this.memoryCache.set(key, { value, expiresAt: Date.now() + safeTtl });
    }

    async deleteGuestSessionHistory(guestId) {
        const key = `${PREFIX}:guest-session:${hashKey(guestId)}`;
        if (this.mode === 'redis') {
            await this.redis.del(key);
            return;
        }
        this.memoryCache.delete(key);
    }

    /**
     * A small JSON cache for read-only commerce tools. It is intentionally
     * separate from authentication cache keys and is safe to use in every
     * gateway replica. Callers must include all audience-changing dimensions
     * (store, currency, customer group) in `identity`.
     */
    async getJsonCache(namespace, identity) {
        const key = this.buildCacheKey(namespace, identity);
        if (this.mode === 'redis') {
            const raw = await this.redis.get(key);
            if (raw === null) return { hit: false, value: null };
            try {
                return { hit: true, value: JSON.parse(raw) };
            } catch {
                await this.redis.del(key);
                return { hit: false, value: null };
            }
        }

        const entry = this.memoryCache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
            this.memoryCache.delete(key);
            return { hit: false, value: null };
        }

        return { hit: true, value: entry.value };
    }

    async setJsonCache(namespace, identity, value, ttlMs) {
        const key = this.buildCacheKey(namespace, identity);
        const safeTtl = numberFromEnv(ttlMs, 60000, 1000, 3600000);
        if (this.mode === 'redis') {
            await this.redis.set(key, JSON.stringify(value), 'PX', safeTtl);
            return;
        }

        this.memoryCache.set(key, { value, expiresAt: Date.now() + safeTtl });
    }

    async deleteJsonCache(namespace, identity) {
        const key = this.buildCacheKey(namespace, identity);
        if (this.mode === 'redis') {
            await this.redis.del(key);
            return;
        }

        this.memoryCache.delete(key);
    }

    /**
     * Collapse simultaneous cache misses for the same catalog/availability
     * request. Redis mode coordinates across gateway processes; memory mode is
     * used only in tests and local single-process development.
     */
    async getOrSetJsonCache(namespace, identity, options, loader) {
        const cached = await this.getJsonCache(namespace, identity);
        if (cached.hit) return { value: cached.value, cacheHit: true };

        const ttlMs = numberFromEnv(options?.ttlMs, 60000, 1000, 3600000);
        const lockMs = numberFromEnv(options?.lockMs, 15000, 1000, 60000);
        const waitMs = numberFromEnv(options?.waitMs, lockMs + 1000, 1000, 120000);
        const cacheKey = this.buildCacheKey(namespace, identity);

        if (this.mode === 'memory') {
            const inFlight = this.memorySingleFlight.get(cacheKey);
            if (inFlight) return inFlight;

            const request = (async () => {
                const value = await loader();
                await this.setJsonCache(namespace, identity, value, ttlMs);
                return { value, cacheHit: false };
            })();
            this.memorySingleFlight.set(cacheKey, request);
            try {
                return await request;
            } finally {
                this.memorySingleFlight.delete(cacheKey);
            }
        }

        const lockKey = `${cacheKey}:lock`;
        const lockToken = `${this.instanceId}:${crypto.randomUUID()}`;
        const startedAt = Date.now();

        while (Date.now() - startedAt < waitMs) {
            const acquired = await this.redis.set(lockKey, lockToken, 'PX', lockMs, 'NX');
            if (acquired === 'OK') {
                try {
                    const refreshed = await this.getJsonCache(namespace, identity);
                    if (refreshed.hit) return { value: refreshed.value, cacheHit: true };

                    const value = await loader();
                    await this.setJsonCache(namespace, identity, value, ttlMs);
                    return { value, cacheHit: false };
                } finally {
                    await this.redis.eval(CACHE_UNLOCK_SCRIPT, 1, lockKey, lockToken).catch(() => {});
                }
            }

            await sleep(Math.min(50, Math.max(10, lockMs / 20)));
            const refreshed = await this.getJsonCache(namespace, identity);
            if (refreshed.hit) return { value: refreshed.value, cacheHit: true };
        }

        // The original request may have died while holding the lock. Read data
        // rather than failing the shopper; the fresh result still becomes cached.
        const value = await loader();
        await this.setJsonCache(namespace, identity, value, ttlMs);
        return { value, cacheHit: false };
    }

    buildCacheKey(namespace, identity) {
        const safeNamespace = String(namespace || 'default')
            .toLowerCase()
            .replace(/[^a-z0-9:_-]/g, '_')
            .slice(0, 80) || 'default';
        return `${PREFIX}:cache:${safeNamespace}:${hashKey(identity)}`;
    }

    /** Claim a browser ticket once so a captured URL cannot open extra sockets. */
    async claimWebSocketTicket(ticketId, ttlSeconds = 60) {
        return this.claimOnce('ticket', ticketId, ttlSeconds * 1000);
    }

    /** Atomically claim an opaque identifier for a short replay-protection window. */
    async claimOnce(namespace, identity, ttlMs = 300000) {
        const safeNamespace = String(namespace || 'nonce')
            .toLowerCase()
            .replace(/[^a-z0-9:_-]/g, '_')
            .slice(0, 48) || 'nonce';
        const key = `${PREFIX}:once:${safeNamespace}:${hashKey(identity)}`;
        const safeTtl = numberFromEnv(ttlMs, 300000, 1000, 600000);
        if (this.mode === 'redis') {
            const result = await this.redis.set(key, this.instanceId, 'PX', safeTtl, 'NX');
            return result === 'OK';
        }
        const existing = this.memoryCache.get(key);
        if (existing && existing.expiresAt > Date.now()) return false;
        this.memoryCache.set(key, { value: this.instanceId, expiresAt: Date.now() + safeTtl });
        return true;
    }

    async getConfig() {
        if (this.mode === 'redis') {
            const value = await this.redis.get(`${PREFIX}:config:active`);
            if (!value) return null;
            try { return JSON.parse(value); } catch { return null; }
        }
        return this.memoryConfig;
    }

    async setConfig(config) {
        if (this.mode === 'redis') {
            await this.redis.set(`${PREFIX}:config:active`, JSON.stringify(config));
            return;
        }
        this.memoryConfig = config;
    }
}

let sharedRuntime = null;

export function getGatewayRuntime() {
    if (!sharedRuntime) sharedRuntime = new GatewayRuntime();
    return sharedRuntime;
}

export { hashKey, runtimeError };
