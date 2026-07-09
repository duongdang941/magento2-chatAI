import { getAiConfig } from '../configuration/config-service.js';
import { transcribeVoice } from '../media/voice-transcription.js';
import { acquireVoiceTranscriptionAdmission } from '../media/voice-transcription-guard.js';
import { summarizeError } from '../gateway/error-summary.js';

function formatVoiceError(error) {
    switch (String(error?.code || '')) {
        case 'VOICE_UNSUPPORTED_FORMAT':
            return 'This browser audio format is not supported.';
        case 'VOICE_AUDIO_TOO_LARGE':
            return 'The recording is larger than this store allows.';
        case 'VOICE_DURATION_EXCEEDED':
            return 'The recording is longer than this store allows.';
        case 'VOICE_EMPTY_TRANSCRIPT':
            return 'No speech was detected. Please try again.';
        case 'VOICE_TIMEOUT':
            return 'Voice transcription took too long. Please try again.';
        case 'VOICE_PROVIDER_UNSUPPORTED':
            return 'Voice dictation is unavailable with the current AI provider.';
        case 'VOICE_PROVIDER_UNAVAILABLE':
            return 'Voice dictation is not configured for the selected AI provider. Check the provider key and transcription model.';
        case 'VOICE_INVALID_AUDIO':
            return 'The recorded audio could not be read. Please record a shorter message and try again.';
        case 'VOICE_DISABLED':
            return 'Voice dictation is disabled for this store.';
        default:
            if (Number(error?.status) === 404 || /not found|no longer available|model .* unavailable/i.test(String(error?.message || ''))) {
                return 'The selected voice model is not available. Choose a current audio-capable model in the AI settings and sync the configuration.';
            }
            if (Number(error?.status) >= 400) {
                return `Voice provider rejected the recording (HTTP ${Number(error.status)}). Check the selected provider voice model and try again.`;
            }
            return 'Voice transcription could not be completed. Please try again.';
    }
}

/**
 * Voice dictation is a transient request: only an approved transcript can be
 * persisted later by the normal chat action. Audio itself never reaches DB.
 */
export async function handleVoiceTranscription({ ws, data, client, runtime, metrics, attachRequestId }) {
    const requestId = String(data.request_id || '').slice(0, 120);
    const send = (payload) => ws.send(attachRequestId(payload, requestId));
    const config = await getAiConfig(runtime, client?.catalogScope?.storeCode || '');

    if (config.voice?.enabled !== true) {
        send({ type: 'voice_error', code: 'VOICE_DISABLED', content: 'Voice dictation is disabled for this store.' });
        return;
    }

    const admission = await acquireVoiceTranscriptionAdmission({
        runtime,
        identity: client?.rateLimitKey,
        config
    });
    if (!admission.allowed) {
        metrics.increment('voice_rejected', { reason: admission.reason || 'unknown' });
        send({
            type: 'voice_error',
            code: String(admission.reason || 'VOICE_UNAVAILABLE').toUpperCase(),
            retry_after: Math.max(1, Math.ceil((Number(admission.retryAfterMs) || 0) / 1000)),
            content: admission.reason === 'voice_rate_limited'
                ? 'Please wait a moment before recording another voice message.'
                : 'Another voice transcription is still in progress. Please try again in a moment.'
        });
        return;
    }

    try {
        metrics.increment('voice_transcription_started', { provider: config.provider });
        const startedAt = Date.now();
        const text = await transcribeVoice({ payload: data, config });
        metrics.increment('voice_transcription_completed', { provider: config.provider });
        metrics.observe('voice_transcription', (Date.now() - startedAt) / 1000, { provider: config.provider });
        send({ type: 'voice_transcript', text });
    } catch (error) {
        const code = String(error?.code || 'VOICE_TRANSCRIPTION_FAILED');
        metrics.increment('voice_transcription_failed', { code });
        console.warn('[Voice] Transcription failed:', summarizeError(error));
        send({ type: 'voice_error', code, content: formatVoiceError(error) });
    } finally {
        await admission.release?.();
    }
}
