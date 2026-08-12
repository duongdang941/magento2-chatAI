import { createLiveVoiceClientSecret } from '../media/live-voice-session.js';

function customerMessage(error) {
    switch (error?.code) {
        case 'VOICE_LIVE_DISABLED':
            return 'Live Voice is not enabled for this store.';
        case 'VOICE_LIVE_RATE_LIMITED':
            return 'Too many voice sessions were started. Please wait a moment and try again.';
        case 'VOICE_LIVE_PROVIDER_UNAVAILABLE':
            return 'Live Voice is temporarily unavailable. You can still use Dictation or type your message.';
        default:
            return 'Live Voice could not be started. Please try again.';
    }
}

/**
 * The browser receives only a one-time/short-lived Realtime credential over
 * its already authenticated WebSocket. No OpenAI API key is ever emitted.
 */
export async function handleLiveVoiceSession({
    ws,
    data,
    client,
    runtime,
    metrics,
    getConfig,
    attachRequestId,
    createSession = createLiveVoiceClientSecret
}) {
    const requestId = String(data?.request_id || '').slice(0, 120);
    const send = (payload) => ws.send(attachRequestId({ ...payload, request_id: requestId }, requestId));
    const config = await getConfig(runtime, client?.catalogScope?.storeCode || '');
    const identity = String(client?.rateLimitKey || client?.sessionId || 'unknown');

    try {
        const limit = Math.max(1, Math.min(Number(config?.voice?.live?.max_sessions_per_minute) || 3, 30));
        const admission = await runtime.consumeRateLimit(`${identity}:live-voice`, {
            limit,
            windowMs: 60 * 1000
        });
        if (!admission.allowed) {
            throw Object.assign(new Error('Live Voice rate limited.'), { code: 'VOICE_LIVE_RATE_LIMITED' });
        }

        const session = await createSession({ config });
        metrics.increment('live_voice_session_started', { model: session.model });
        send({
            type: 'live_voice_session',
            client_secret: session.clientSecret,
            expires_at: session.expiresAt,
            max_duration_seconds: session.maximumDuration
        });
    } catch (error) {
        metrics.increment('live_voice_session_failed', { code: error?.code || 'unknown' });
        send({ type: 'live_voice_error', code: error?.code || 'VOICE_LIVE_ERROR', content: customerMessage(error) });
    }
}
