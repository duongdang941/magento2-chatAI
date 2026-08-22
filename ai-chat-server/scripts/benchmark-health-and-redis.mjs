import { registerGatewayHttpRoutes } from '../services/gateway/gateway-http-routes.js';
import { GatewayRuntime } from '../services/gateway/gateway-runtime.js';

const durations = [];
const routes = new Map();
const app = {
    use() {},
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); }
};
registerGatewayHttpRoutes({
    app,
    runtime: { getHealth: () => ({ connected: true, mode: 'benchmark' }) },
    metrics: { toPrometheus: async () => '' },
    db: { pingMagento: async () => true },
    websocketConnections: () => 0,
    syncSecret: 'b'.repeat(32)
});
const health = routes.get('GET /health');
const request = {};
const runHealth = async () => {
    const started = performance.now();
    let statusCode = 0;
    await health(request, { status(code) { statusCode = code; return this; }, json() {} });
    durations.push({ ms: performance.now() - started, statusCode });
};
const total = Number(process.env.BENCH_REQUESTS || 10000);
const concurrency = Number(process.env.BENCH_CONCURRENCY || 200);
for (let offset = 0; offset < total; offset += concurrency) {
    await Promise.all(Array.from({ length: Math.min(concurrency, total - offset) }, runHealth));
}
const sorted = durations.map(item => item.ms).sort((a, b) => a - b);
const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
console.log(JSON.stringify({ benchmark: 'health-route-handler', total, concurrency, p50_ms: percentile(0.50), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: sorted.at(-1), statuses: [...new Set(durations.map(item => item.statusCode))] }, null, 2));

class ChaosRedis {
    constructor() { this.status = 'wait'; this.failPing = false; this.quitCount = 0; this.disconnectCount = 0; }
    async connect() { this.status = 'ready'; }
    async ping() { if (this.failPing) throw new Error('redis-chaos-down'); return 'PONG'; }
    async quit() { this.quitCount += 1; this.status = 'end'; }
    disconnect() { this.disconnectCount += 1; this.status = 'end'; }
}
const redis = new ChaosRedis();
const runtime = new GatewayRuntime({ redis, redisUrl: 'redis://chaos-test', allowInMemory: false, instanceId: 'benchmark-chaos' });
const chaos = [];
await runtime.connect();
chaos.push({ scenario: 'healthy-connect', connected: runtime.connected, mode: runtime.mode });
redis.failPing = true;
await runtime.disconnect();
try { await runtime.connect(); } catch (error) { chaos.push({ scenario: 'redis-down', code: error.code, connected: runtime.connected, quitCount: redis.quitCount, disconnectCount: redis.disconnectCount }); }
redis.failPing = false;
redis.status = 'wait';
await runtime.connect();
chaos.push({ scenario: 'recovery', connected: runtime.connected, mode: runtime.mode });
console.log(JSON.stringify({ chaos }, null, 2));
