import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const frontendConnectionSource = fs.readFileSync(
    new URL('../../view/frontend/web/js/chat/connection.js', import.meta.url),
    'utf8'
);
const gatewaySource = fs.readFileSync(
    new URL('../server.js', import.meta.url),
    'utf8'
);

test('does not recycle a healthy WebSocket when its admission ticket ages', () => {
    assert.doesNotMatch(frontendConnectionSource, /Refreshing chat authentication/);
    assert.doesNotMatch(frontendConnectionSource, /ticketRefreshTimer/);
    assert.doesNotMatch(gatewaySource, /Chat authentication expired/);
    assert.doesNotMatch(gatewaySource, /ticketExpiresAt/);
});
