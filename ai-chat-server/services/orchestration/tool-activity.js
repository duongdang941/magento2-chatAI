/**
 * Customer-safe progress events for tool-using model runs.
 *
 * These events intentionally expose only the storefront action and a bounded
 * result count. They never include prompts, tool arguments, response payloads,
 * credentials, or hidden model reasoning.
 */
export function createToolActivityId(toolCallId, toolName) {
    const callId = String(toolCallId || '').trim();
    if (callId) return `tool-${callId}`;

    const name = String(toolName || 'action')
        .replace(/[^a-z0-9_-]/gi, '-')
        .slice(0, 40) || 'action';

    return `tool-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emitToolActivity(ws, { activityId, toolName, state, result } = {}) {
    if (!ws || typeof ws.send !== 'function') return;

    const payload = {
        type: 'tool_activity',
        activity_id: String(activityId || createToolActivityId('', toolName)),
        tool: String(toolName || 'unknown'),
        state: normalizeState(state)
    };
    const resultCount = getResultCount(result);

    if (resultCount !== null) payload.result_count = resultCount;
    ws.send(JSON.stringify(payload));
}

function normalizeState(value) {
    return ['running', 'completed', 'failed'].includes(value) ? value : 'running';
}

function getResultCount(result) {
    if (!result || typeof result !== 'object') return null;
    if (Array.isArray(result.data)) return result.data.length;

    const count = Number(result.count);
    if (Number.isFinite(count) && count >= 0) return Math.trunc(count);

    const total = Number(result.total);
    return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null;
}
