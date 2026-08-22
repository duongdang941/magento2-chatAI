import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderCircuitBreaker } from '../services/providers/provider-circuit-breaker.js';

test('provider circuit opens after repeated failures and recovers after success', () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    assert.equal(breaker.beforeRequest('provider-a').allowed, true);
    breaker.recordFailure('provider-a');
    breaker.recordFailure('provider-a');
    assert.equal(breaker.beforeRequest('provider-a').allowed, false);
    breaker.recordSuccess('provider-a');
    assert.equal(breaker.beforeRequest('provider-a').allowed, true);
});

test('provider circuit tracks providers independently', () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    breaker.recordFailure('provider-a');
    assert.equal(breaker.beforeRequest('provider-a').allowed, false);
    assert.equal(breaker.beforeRequest('provider-b').allowed, true);
    assert.equal(breaker.snapshot()[0].state, 'open');
});
