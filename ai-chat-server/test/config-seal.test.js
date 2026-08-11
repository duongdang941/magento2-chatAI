import test from 'node:test';
import assert from 'node:assert/strict';

import { isSealedConfig, sealConfig, unsealConfig } from '../services/config-seal.js';

test('encrypts provider and Magento credentials before persistence', () => {
    const secret = 's'.repeat(32);
    const config = {
        provider: 'cockpit',
        api_key: 'provider-secret',
        magento_oauth: { access_token: 'oauth-secret' }
    };
    const sealed = sealConfig(config, secret);
    const serialized = JSON.stringify(sealed);

    assert.equal(isSealedConfig(sealed), true);
    assert.equal(serialized.includes('provider-secret'), false);
    assert.equal(serialized.includes('oauth-secret'), false);
    assert.deepEqual(unsealConfig(sealed, secret), config);
});

test('rejects tampered configuration snapshots', () => {
    const secret = 'k'.repeat(32);
    const sealed = sealConfig({ provider: 'cockpit' }, secret);
    const index = Math.floor(sealed.ciphertext.length / 2);
    const replacement = sealed.ciphertext[index] === 'A' ? 'B' : 'A';
    sealed.ciphertext = `${sealed.ciphertext.slice(0, index)}${replacement}${sealed.ciphertext.slice(index + 1)}`;

    assert.throws(() => unsealConfig(sealed, secret), /authenticated or decrypted/);
});
