import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayRuntime } from '../services/gateway/gateway-runtime.js';
import { normalizeVoicePayload, transcribeVoice } from '../services/media/voice-transcription.js';
import { acquireVoiceTranscriptionAdmission } from '../services/media/voice-transcription-guard.js';

const voiceConfig = {
    max_duration_seconds: 30,
    max_audio_bytes: 262144,
    requests_per_minute: 2,
    max_concurrent_per_identity: 1,
    timeout_ms: 10000
};

test('normalizes a short supported temporary recording without persisting it', () => {
    const payload = normalizeVoicePayload({
        mime_type: 'audio/webm;codecs=opus',
        duration_seconds: 3,
        audio: Buffer.from('temporary voice bytes').toString('base64')
    }, voiceConfig);

    assert.equal(payload.mimeType, 'audio/webm');
    assert.equal(payload.durationSeconds, 3);
    assert.equal(payload.bytes.toString(), 'temporary voice bytes');
    payload.bytes.fill(0);
});

test('accepts Safari-compatible temporary audio MIME types', () => {
    for (const mimeType of ['audio/mp4;codecs=mp4a.40.2', 'audio/x-m4a', 'audio/aac']) {
        const payload = normalizeVoicePayload({
            mime_type: mimeType,
            duration_seconds: 2,
            audio: Buffer.from('temporary Safari voice bytes').toString('base64')
        }, voiceConfig);

        assert.equal(payload.durationSeconds, 2);
        payload.bytes.fill(0);
    }
});

test('rejects unsupported, oversized and excessively long recordings before a provider request', () => {
    assert.throws(() => normalizeVoicePayload({
        mime_type: 'video/webm', duration_seconds: 2, audio: 'YQ=='
    }, voiceConfig), { code: 'VOICE_UNSUPPORTED_FORMAT' });
    assert.throws(() => normalizeVoicePayload({
        mime_type: 'audio/webm', duration_seconds: 31, audio: 'YQ=='
    }, voiceConfig), { code: 'VOICE_DURATION_EXCEEDED' });
    assert.throws(() => normalizeVoicePayload({
        mime_type: 'audio/webm', duration_seconds: 2, audio: Buffer.alloc((256 * 1024) + 1).toString('base64')
    }, voiceConfig), { code: 'VOICE_AUDIO_TOO_LARGE' });
});

test('uses an audio-capable Gemini model when Admin still contains the legacy OpenAI transcription model', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = null;
    globalThis.fetch = async (url, options) => {
        requestUrl = url;
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'xin chao' }] } }]
        }), { status: 200 });
    };
    try {
        const text = await transcribeVoice({
            payload: {
                mime_type: 'audio/webm;codecs=opus',
                duration_seconds: 2,
                audio: Buffer.from('temporary voice bytes').toString('base64')
            },
            config: {
                provider: 'gemini',
                api_key: 'test-key',
                base_url: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-3.1-flash-lite',
                voice: { ...voiceConfig, transcription_model: 'gpt-4o-mini-transcribe' }
            }
        });
        assert.equal(text, 'xin chao');
        assert.match(requestUrl, /models\/gemini-3\.1-flash-lite:generateContent$/);
        assert.equal(requestBody.contents[0].parts[1].inlineData.mimeType, 'audio/webm');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('enforces voice rate and per-shopper concurrency through the shared runtime', async () => {
    const runtime = new GatewayRuntime({ allowInMemory: true, instanceId: 'voice-transcription-test' });
    await runtime.connect();
    const first = await acquireVoiceTranscriptionAdmission({ runtime, identity: 'guest:voice', config: { voice: voiceConfig } });
    assert.equal(first.allowed, true);
    const busy = await acquireVoiceTranscriptionAdmission({ runtime, identity: 'guest:voice', config: { voice: voiceConfig } });
    assert.equal(busy.allowed, false);
    assert.equal(busy.reason, 'voice_busy');
    await first.release();

    const rateLimited = await acquireVoiceTranscriptionAdmission({ runtime, identity: 'guest:voice', config: { voice: voiceConfig } });
    assert.equal(rateLimited.allowed, false);
    assert.equal(rateLimited.reason, 'voice_rate_limited');
});
