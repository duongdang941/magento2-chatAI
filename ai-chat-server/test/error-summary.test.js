import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeError } from '../services/gateway/error-summary.js';

test('redacts provider and OAuth credentials from operational errors', () => {
    const summary = summarizeError({
        code: 'ERR_BAD_REQUEST',
        response: {
            status: 401,
            data: {
                message: 'authorization: Bearer secret-token oauth_consumer_secret="consumer-secret" api_key=provider-secret'
            }
        }
    });

    assert.equal(summary.status, 401);
    assert.equal(summary.code, 'ERR_BAD_REQUEST');
    assert.doesNotMatch(summary.message, /secret-token|consumer-secret|provider-secret/);
    assert.match(summary.message, /\[REDACTED\]/);
});
