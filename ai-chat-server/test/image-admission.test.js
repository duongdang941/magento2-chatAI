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
