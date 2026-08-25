import assert from 'node:assert/strict';
import test from 'node:test';
import {
    attachRequestId,
    createActiveRunController,
    isAbortError
} from '../services/conversation/active-run-controller.js';

test('cancels only the matching active request and notifies once', () => {
    const messages = [];
    const ws = { send: (message) => messages.push(JSON.parse(message)) };
    const controller = createActiveRunController({ isSocketOpen: () => true });
    const run = controller.createActiveRun(ws, 'request-1');

    assert.equal(controller.cancelActiveRun(ws, 'other'), false);
    assert.equal(controller.cancelActiveRun(ws, 'request-1'), true);
    assert.equal(run.controller.signal.aborted, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].request_id, 'request-1');
    controller.cancelActiveRun(ws, 'request-1');
    assert.equal(messages.length, 1);
});

test('preserves request ids and recognizes abort failures', () => {
    assert.deepEqual(JSON.parse(attachRequestId({ type: 'done' }, 'request-2')), {
        type: 'done',
        request_id: 'request-2'
    });
    assert.equal(isAbortError(Object.assign(new Error('stopped'), { name: 'AbortError' })), true);
    assert.equal(isAbortError(new Error('provider failed')), false);
});

test('records a closed connection as recoverable instead of a shopper stop', () => {
    const messages = [];
    const ws = { send: (message) => messages.push(JSON.parse(message)) };
    const controller = createActiveRunController({ isSocketOpen: () => true });
    const run = controller.createActiveRun(ws, 'request-reload');

    assert.equal(controller.cancelActiveRun(ws, null, 'connection_lost'), true);
    assert.equal(run.interruptionReason, 'connection_lost');
    assert.equal(messages[0].interruption_reason, 'connection_lost');
});
