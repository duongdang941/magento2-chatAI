import test from 'node:test';
import assert from 'node:assert/strict';

import { createCustomerTurnBuffer } from '../services/conversation/customer-turn-buffer.js';

test('does not commit provisional prose from a provider turn that selects a tool', () => {
    const turn = createCustomerTurnBuffer();
    turn.push('I will check the catalogue now.');
    turn.discard();

    assert.equal(turn.commit(), '');
});

test('commits a complete final response after streaming provider deltas', () => {
    const turn = createCustomerTurnBuffer();
    turn.push('The product is ');
    turn.push('available.');

    assert.equal(turn.commit(), 'The product is available.');
});

test('releases safe text while retaining the protected stream suffix', () => {
    const turn = createCustomerTurnBuffer();
    turn.push('A long customer-facing response that continues.');

    assert.equal(turn.release(), 'A long customer-facing re');
    assert.equal(turn.commit(), 'sponse that continues.');
});
