function escapeLabel(value) {
    return String(value || 'unknown').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class GatewayMetrics {
    constructor() {
        this.counters = new Map();
        this.latencies = new Map();
    }

    increment(name, labels = {}) {
        const key = this.key(name, labels);
        this.counters.set(key, (this.counters.get(key) || 0) + 1);
    }

    observe(name, seconds, labels = {}) {
        const key = this.key(name, labels);
        const current = this.latencies.get(key) || { count: 0, sum: 0 };
        current.count += 1;
        current.sum += Math.max(0, Number(seconds) || 0);
        this.latencies.set(key, current);
    }

    key(name, labels) {
        return `${name}|${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`;
    }

    parseKey(key) {
        const separator = key.indexOf('|');
        return {
            name: key.slice(0, separator),
            labels: JSON.parse(key.slice(separator + 1))
        };
    }

    formatLabels(labels) {
        if (!labels.length) return '';
        return `{${labels.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
    }

    async toPrometheus({ runtime, websocketConnections }) {
        const capacity = await runtime.getCapacityMetrics();
        const lines = [
            '# HELP afd_ai_gateway_websocket_connections Current WebSocket connections on this replica.',
            '# TYPE afd_ai_gateway_websocket_connections gauge',
            `afd_ai_gateway_websocket_connections ${Number(websocketConnections) || 0}`,
            '# HELP afd_ai_gateway_model_requests_active Active model requests across all replicas.',
            '# TYPE afd_ai_gateway_model_requests_active gauge',
            `afd_ai_gateway_model_requests_active ${capacity.active}`,
            '# HELP afd_ai_gateway_queue_depth Requests waiting for a global model slot.',
            '# TYPE afd_ai_gateway_queue_depth gauge',
            `afd_ai_gateway_queue_depth ${capacity.queued}`
        ];

        for (const [key, value] of this.counters.entries()) {
            const { name, labels } = this.parseKey(key);
            lines.push(`afd_ai_gateway_${name}_total${this.formatLabels(labels)} ${value}`);
        }
        for (const [key, value] of this.latencies.entries()) {
            const { name, labels } = this.parseKey(key);
            const labelString = this.formatLabels(labels);
            lines.push(`afd_ai_gateway_${name}_seconds_sum${labelString} ${value.sum}`);
            lines.push(`afd_ai_gateway_${name}_seconds_count${labelString} ${value.count}`);
        }

        return lines.join('\n') + '\n';
    }
}
