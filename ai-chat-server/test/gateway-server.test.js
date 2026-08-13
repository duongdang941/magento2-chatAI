import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createGatewayServer } from '../services/gateway/gateway-server.js';

test('uses HTTP when neither direct TLS path is configured', () => {
    const server = createGatewayServer(express(), {});
    assert.equal(server.constructor.name, 'Server');
    assert.equal(typeof server.setSecureContext, 'undefined');
    server.close();
});

test('requires both direct TLS paths together', () => {
    assert.throws(
        () => createGatewayServer(express(), { TLS_CERT_PATH: '/tmp/cert.pem' }),
        /configured together/
    );
});
