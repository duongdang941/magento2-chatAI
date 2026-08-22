import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

const configDirectory = fs.mkdtempSync(`${os.tmpdir()}/afd-ai-config-`);
process.env.AI_CONFIG_DIRECTORY = configDirectory;
process.env.AI_CONFIG_FILE = `${configDirectory}/ai-config.json`;
process.env.AI_NODE_SYNC_SECRET = 't'.repeat(32);

const {
    applyPushedConfig,
    clearConfigCache,
    getAiConfig,
    getMagentoBaseUrl
} = await import('../services/configuration/config-service.js');

function tenantConfig(tenantId, provider, apiKey, magentoBaseUrl) {
    const providerEntry = {
        provider_id: provider === 'gemini' ? 1 : 2,
        provider_code: provider,
        code: provider,
        name: provider,
        api_key: apiKey,
        api_format: 'openai-chat-completions',
        models: [{ id: provider === 'gemini' ? 'gemini-test' : 'router-test' }],
        is_active: true
    };
    return {
        tenant_id: tenantId,
        default: {
            enabled: true,
            provider,
            model: provider === 'gemini' ? 'gemini-test' : 'router-test',
            api_key: apiKey,
            magento_base_url: magentoBaseUrl,
            providers: { [provider]: providerEntry }
        },
        stores: {
            default: {
                enabled: true,
                provider,
                model: provider === 'gemini' ? 'gemini-test' : 'router-test',
                api_key: apiKey,
                magento_base_url: magentoBaseUrl,
                providers: { [provider]: providerEntry }
            }
        }
    };
}

test('keeps separate Magento installations isolated in one shared config snapshot', async () => {
    clearConfigCache();
    let distributed = null;
    const runtime = {
        async getConfig() { return distributed; },
        async setConfig(value) { distributed = value; }
    };
    const firstTenant = 'a'.repeat(64);
    const secondTenant = 'b'.repeat(64);

    await applyPushedConfig(
        tenantConfig(firstTenant, 'gemini', 'gemini-secret', 'https://shop-a.example'),
        runtime
    );
    await applyPushedConfig(
        tenantConfig(secondTenant, '9router', 'router-secret', 'https://shop-b.example'),
        runtime
    );

    const first = await getAiConfig(runtime, 'default', firstTenant);
    const second = await getAiConfig(runtime, 'default', secondTenant);
    assert.equal(first.provider, 'gemini');
    assert.equal(first.api_key, 'gemini-secret');
    assert.equal(getMagentoBaseUrl('default', firstTenant), 'https://shop-a.example');
    assert.equal(second.provider, '9router');
    assert.equal(second.api_key, 'router-secret');
    assert.equal(getMagentoBaseUrl('default', secondTenant), 'https://shop-b.example');
});
