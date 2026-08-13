import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    findLocalValetCa,
    localGatewayTlsEnvironment
} from '../services/configuration/local-magento-bootstrap.js';

test('discovers a Valet CA relative to the current local home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afd-ai-valet-'));
    const caDirectory = path.join(home, '.config', 'valet', 'CA');
    const caFile = path.join(caDirectory, 'LaravelValetCASelfSigned.pem');
    fs.mkdirSync(caDirectory, { recursive: true });
    fs.writeFileSync(caFile, 'test-ca');

    try {
        assert.equal(findLocalValetCa(home), caFile);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('does not invent a Valet path when Valet is not installed', () => {
    assert.equal(findLocalValetCa(path.join(os.tmpdir(), 'afd-ai-missing-valet')), '');
});

test('uses local Valet certificate files only when the configured host has them', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afd-ai-valet-tls-'));
    const certificateDirectory = path.join(home, '.config', 'valet', 'Certificates');
    const certificatePath = path.join(certificateDirectory, 'shop.test.crt');
    const privateKeyPath = path.join(certificateDirectory, 'shop.test.key');
    fs.mkdirSync(certificateDirectory, { recursive: true });
    fs.writeFileSync(certificatePath, 'certificate');
    fs.writeFileSync(privateKeyPath, 'key');

    try {
        const environment = localGatewayTlsEnvironment({ HOME: home, MAGENTO_HOST: 'shop.test' });
        assert.equal(environment.TLS_CERT_PATH, certificatePath);
        assert.equal(environment.TLS_KEY_PATH, privateKeyPath);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
