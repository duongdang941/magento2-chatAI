import 'dotenv/config';
import assert from 'node:assert/strict';
import axios from 'axios';
import { createInternalMagentoRequestConfig } from '../services/gateway/magento-auth.js';

const gatewayUrl = String(process.env.AI_GATEWAY_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const magentoInternalUrl = String(process.env.MAGENTO_API_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const magentoPublicUrl = String(process.env.MAGENTO_PUBLIC_BASE_URL || 'http://afd.test').replace(/\/+$/, '');

async function request(config) {
    return axios({ timeout: 10000, validateStatus: () => true, ...config });
}

async function main() {
    const gatewayHealth = await request({ method: 'GET', url: `${gatewayUrl}/health` });
    assert.equal(gatewayHealth.status, 200, 'Gateway health must return HTTP 200.');
    assert.deepEqual(gatewayHealth.data, { status: 'ok' }, 'Gateway health must not expose internals.');

    for (const path of [
        '/rest/V1/afd-ai/products/availability?sku=integration-smoke',
        '/rest/V1/afd-ai/coupons'
    ]) {
        const response = await request({ method: 'GET', url: `${magentoPublicUrl}${path}` });
        assert.ok(
            response.status === 401 || response.status === 403,
            `Anonymous protected endpoint ${path} returned ${response.status}.`
        );
    }

    const healthUrl = `${magentoInternalUrl}/rest/V1/afd-ai/health`;
    const signedConfig = createInternalMagentoRequestConfig('GET', healthUrl, '', { contentType: false });
    const first = await request({ method: 'GET', url: healthUrl, ...signedConfig });
    const replay = await request({ method: 'GET', url: healthUrl, ...signedConfig });
    assert.equal(first.status, 200, 'A fresh internal signature must be accepted.');
    assert.ok(
        replay.status === 401 || replay.status === 403,
        `A replayed internal signature returned ${replay.status}.`
    );

    process.stdout.write(JSON.stringify({
        gateway_health: 'ok',
        protected_catalog: 'ok',
        hmac_fresh: first.status,
        hmac_replay: replay.status
    }) + '\n');
}

main().catch((error) => {
    process.stderr.write(`Integration smoke failed: ${error.message}\n`);
    process.exitCode = 1;
});
