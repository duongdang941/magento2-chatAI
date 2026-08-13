import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayMetrics } from '../services/gateway/gateway-metrics.js';

test('publishes context byte totals separately from latency metrics', async () => {
    const metrics = new GatewayMetrics();
    metrics.observeBytes('tool_context_raw', 1200, { tool: 'searchProducts' });
    metrics.observeBytes('tool_context_raw', 800, { tool: 'searchProducts' });
    const output = await metrics.toPrometheus({
        runtime: { getCapacityMetrics: async () => ({ active: 0, queued: 0 }) },
        websocketConnections: 1
    });

    assert.match(output, /afd_ai_gateway_tool_context_raw_bytes_sum\{tool="searchProducts"\} 2000/);
    assert.match(output, /afd_ai_gateway_tool_context_raw_bytes_count\{tool="searchProducts"\} 2/);
    assert.doesNotMatch(output, /tool_context_raw_seconds/);
});
