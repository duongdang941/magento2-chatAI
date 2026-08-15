import test from 'node:test';
import assert from 'node:assert/strict';
import { admitImageRequest, imageRequestCost } from '../services/media/image-admission.js';

test('weights vision admission by image count and byte volume', () => {
    const oneMiB = Buffer.alloc(1024 * 1024).toString('base64');
    const cost = imageRequestCost([
        { inline_data: { data: oneMiB } },
        { inline_data: { data: oneMiB } }
    ]);
    assert.equal(cost.imageCount, 2);
    assert.equal(cost.units, 8);
});

test('applies weighted vision quota to identity, network and global scopes', async () => {
    const calls = [];
    const runtime = {
        async consumeRateLimitBatch(entries) {
            calls.push(entries);
            return { allowed: true, retryAfterMs: 0 };
        }
    };
    const result = await admitImageRequest(runtime, {
        rateLimitKey: 'customer:7', networkRateLimitKey: 'network:a'
    }, [{ inline_data: { data: 'AAAA' } }], {
        cost_units_per_minute: 20,
        network_cost_units_per_minute: 50,
        global_cost_units_per_minute: 100
    });
    assert.equal(result.allowed, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
        { identity: 'customer:7:vision-cost', limit: 20, amount: 4, windowMs: 60000 },
        { identity: 'network:a:vision-cost', limit: 50, amount: 4, windowMs: 60000 },
        { identity: 'global:vision-cost', limit: 100, amount: 4, windowMs: 60000 }
    ]);
});

test('does not consume image quota when the requested amount is rejected', async () => {
    const calls = [];
    const runtime = {
        async consumeRateLimitBatch(entries) {
            calls.push(entries);
            return { allowed: false, count: 3, retryAfterMs: 500 };
        }
    };

    const result = await admitImageRequest(runtime, {
        rateLimitKey: 'customer:7', networkRateLimitKey: 'network:a'
    }, [{ inline_data: { data: 'AAAA' } }], {
        cost_units_per_minute: 20,
        network_cost_units_per_minute: 50,
        global_cost_units_per_minute: 100
    });

    assert.equal(result.allowed, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].amount, 4);
});

test('calculates cost for attachment_ref with explicit bytes and default fallback bytes', () => {
    // 1 attachment with 2MB explicit bytes
    const costExplicit = imageRequestCost([
        { type: 'attachment_ref', attachment_id: 'att_123', bytes: 2 * 1024 * 1024 }
    ]);
    assert.equal(costExplicit.imageCount, 1);
    assert.equal(costExplicit.units >= 5, true);

    // 1 attachment without bytes (uses 1MB default)
    const costDefault = imageRequestCost([
        { type: 'attachment_ref', attachment_id: 'att_456' }
    ]);
    assert.equal(costDefault.imageCount, 1);
    assert.equal(costDefault.units >= 4, true);

    // Multiple attachments
    const costMulti = imageRequestCost([
        { type: 'attachment_ref', attachment_id: 'att_1', bytes: 1024 * 1024 },
        { type: 'attachment_ref', attachment_id: 'att_2', bytes: 2 * 1024 * 1024 }
    ]);
    assert.equal(costMulti.imageCount, 2);
    assert.equal(costMulti.units >= 8, true);
});

test('batch rate limit rejection does not cause partial debit', async () => {
    let batchCalled = false;
    const runtime = {
        async consumeRateLimitBatch(entries) {
            batchCalled = true;
            return { allowed: false, count: 50, retryAfterMs: 3000 };
        }
    };

    const result = await admitImageRequest(runtime, {
        rateLimitKey: 'customer:99', networkRateLimitKey: 'network:z'
    }, [
        { type: 'attachment_ref', attachment_id: 'att_test', bytes: 1024 * 1024 }
    ]);

    assert.equal(batchCalled, true);
    assert.equal(result.allowed, false);
    assert.equal(result.cost.imageCount, 1);
});
