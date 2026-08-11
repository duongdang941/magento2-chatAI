import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmoothChunkEmitter } from '../services/smooth-chunk-emitter.js';

test('paces a provider burst into ordered, bounded chunks', async () => {
    const chunks = [];
    const emitter = createSmoothChunkEmitter({
        emit: chunk => chunks.push(chunk),
        intervalMs: 1,
        targetFrames: 4,
        minChars: 2,
        maxChars: 6
    });

    emitter.push('abcdefghijklmnopqrstuvwxyz');
    await emitter.drain();

    assert.equal(chunks.join(''), 'abcdefghijklmnopqrstuvwxyz');
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => Array.from(chunk).length <= 6));
});

test('never splits a unicode code point', async () => {
    const chunks = [];
    const emitter = createSmoothChunkEmitter({
        emit: chunk => chunks.push(chunk),
        intervalMs: 1,
        minChars: 1,
        maxChars: 1
    });

    emitter.push('A🤖B');
    await emitter.drain();

    assert.deepEqual(chunks, ['A', '🤖', 'B']);
});

test('drops queued text when the request is cancelled', async () => {
    const chunks = [];
    let cancelled = false;
    const emitter = createSmoothChunkEmitter({
        emit: chunk => {
            chunks.push(chunk);
            cancelled = true;
        },
        isCancelled: () => cancelled,
        intervalMs: 1,
        minChars: 1,
        maxChars: 1
    });

    emitter.push('cancel-me');
    await emitter.drain();

    assert.equal(chunks.join(''), 'c');
});
