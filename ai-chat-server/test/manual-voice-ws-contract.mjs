import fs from 'node:fs';
import WebSocket from 'ws';

const sessionFile = process.argv[2] || '/tmp/afd-voice-session.json';
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const endpoint = process.env.AI_GATEWAY_WS_URL || 'ws://127.0.0.1:3001';
const ws = new WebSocket(`${endpoint}?ticket=${encodeURIComponent(session.websocketTicket)}`, {
    origin: process.env.AI_GATEWAY_ORIGIN || 'http://afd.test'
});

const timeout = setTimeout(() => {
    console.error('Timed out waiting for the voice validation response.');
    process.exit(1);
}, 8000);

ws.on('open', () => ws.send(JSON.stringify({
    action: 'voice_transcribe',
    request_id: 'voice-contract-test',
    mime_type: 'video/webm',
    duration_seconds: 1,
    audio: 'YQ=='
})));

ws.on('message', raw => {
    const data = JSON.parse(raw);
    if (data.type !== 'voice_error') return;
    console.log(JSON.stringify({
        type: data.type,
        code: data.code,
        content: data.content,
        request_id: data.request_id
    }));
    clearTimeout(timeout);
    ws.close();
});

ws.on('close', () => process.exit(0));
ws.on('error', error => {
    clearTimeout(timeout);
    console.error(error.message);
    process.exit(1);
});
