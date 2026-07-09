import { interruptedResponseMetadata } from './interrupted-response.js';

export function attachRequestId(message, requestId) {
    try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;
        return JSON.stringify({ ...parsed, request_id: parsed.request_id || requestId });
    } catch {
        return message;
    }
}

export function isAbortError(error) {
    return Boolean(error) && (
        error.name === 'AbortError'
        || /abort|aborted/i.test(error.message || '')
    );
}

export function createActiveRunController({ isSocketOpen }) {
    const activeRuns = new Map();

    function notifyCancelled(ws, run) {
        if (!run || run.cancelNotified || !isSocketOpen(ws)) return;

        run.cancelNotified = true;
        ws.send(JSON.stringify({
            type: 'cancelled',
            request_id: run.requestId,
            ...interruptedResponseMetadata(run.startedAt)
        }));
    }

    function cancelActiveRun(ws, requestId = null) {
        const run = activeRuns.get(ws);
        if (!run || (requestId && run.requestId !== requestId)) return false;

        run.cancelled = true;
        if (!run.controller.signal.aborted) run.controller.abort();
        notifyCancelled(ws, run);
        return true;
    }

    function createActiveRun(ws, requestId = null) {
        cancelActiveRun(ws);
        const run = {
            requestId: requestId || `server-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            controller: new AbortController(),
            cancelled: false,
            cancelNotified: false,
            startedAt: Date.now()
        };
        activeRuns.set(ws, run);
        return run;
    }

    function clearActiveRun(ws, run) {
        if (activeRuns.get(ws) === run) activeRuns.delete(ws);
    }

    function isRunCancelled(run) {
        return !run || run.cancelled || run.controller.signal.aborted;
    }

    return {
        cancelActiveRun,
        clearActiveRun,
        createActiveRun,
        isRunCancelled,
        notifyCancelled
    };
}
