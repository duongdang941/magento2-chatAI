import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeSearchPayload } from '../services/gateway/assistant-service-client.js';

test('passes only the Magento-signed customer group into a knowledge search', () => {
    assert.deepEqual(
        knowledgeSearchPayload('return policy', 12, { storeCode: 'de', customerGroupId: 7 }),
        { query: 'return policy', limit: 8, customerGroupId: 7 }
    );
    assert.equal(knowledgeSearchPayload('x', 1, { customerGroupId: -1 }).customerGroupId, 0);
});
