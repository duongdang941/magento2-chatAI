import test from 'node:test';
import assert from 'node:assert/strict';

import {
    acceptsClientContract,
    encodeGatewayEvent,
    installGatewayEventContract
} from '../services/message-contract.js';

test('versions gateway events while retaining the legacy top-level shape', () => {
    assert.deepEqual(JSON.parse(encodeGatewayEvent({ type: 'chunk', content: 'hello' })), {
        contract_version: 1,
        type: 'chunk',
        content: 'hello'
    });
});

test('rejects unsupported future client contracts', () => {
    assert.equal(acceptsClientContract({ action: 'chat' }), true);
    assert.equal(acceptsClientContract({ action: 'chat', contract_version: 2 }), false);
});

test('contract adapter decorates JSON and preserves non-JSON frames', () => {
    const frames = [];
    const socket = { send: (value) => frames.push(value) };
    installGatewayEventContract(socket);
    socket.send(JSON.stringify({ type: 'done' }));
    socket.send('plain');

    assert.equal(JSON.parse(frames[0]).contract_version, 1);
    assert.equal(frames[1], 'plain');
});
