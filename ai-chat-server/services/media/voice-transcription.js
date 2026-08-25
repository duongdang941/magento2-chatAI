const MAX_BASE64_LENGTH = 9 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav'
]);
const MIME_ALIASES = new Map([
    ['audio/flac', 'audio/flac'],
    ['audio/x-flac', 'audio/flac'],
    ['audio/aiff', 'audio/aiff'],
    ['audio/x-aiff', 'audio/aiff']
]);

function readString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

function normalizeBaseUrl(value) {
    return readString(value).replace(/\/+$/, '');
}

function geminiGenerateContentUrl(baseUrl, model) {
    const endpoint = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const safeModel = encodeURIComponent(String(model || '').trim());
    return /\/models$/i.test(endpoint)
        ? `${endpoint}/${safeModel}:generateContent`
        : `${endpoint}/models/${safeModel}:generateContent`;
}

function providerSettings(config = {}) {
    const configuredProvider = readString(config.provider, 'cockpit');
    const apiFormat = readString(config.api_format).toLowerCase();
    const provider = ['cockpit', 'openai', 'openrouter', '9router', 'gemini'].includes(configuredProvider)
        ? configuredProvider
        : (apiFormat === 'openai-chat-completions' || apiFormat === 'openai-responses'
            ? 'openai-compatible'
            : configuredProvider);
    if (!['cockpit', 'openai', 'openrouter', '9router', 'gemini', 'openai-compatible'].includes(provider)) {
        const error = new Error('Voice dictation is not supported by the selected AI provider.');
        error.code = 'VOICE_PROVIDER_UNSUPPORTED';
        throw error;
    }

    const envPrefix = provider === 'cockpit'
        ? 'COCKPIT'
        : provider === 'openai'
            ? 'OPENAI'
            : provider === 'openrouter'
                ? 'OPENROUTER'
                    : provider === '9router' ? 'NINE_ROUTER' : provider === 'gemini' ? 'GEMINI' : 'OPENAI';
    const defaultBaseUrl = provider === 'cockpit'
        ? 'http://127.0.0.1:49998/v1'
        : provider === 'openai'
            ? 'https://api.openai.com/v1'
            : provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                    : provider === '9router'
                    ? 'https://raud4eq.9router.com/v1'
                    : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : '';
    const voice = config.voice && typeof config.voice === 'object' ? config.voice : {};
    const apiKey = readString(config.api_key, process.env[`${envPrefix}_API_KEY`] || '');
    const baseUrl = normalizeBaseUrl(
        config.base_url
            || process.env[`${envPrefix}_BASE_URL`]
            || (provider === 'gemini' ? process.env.GEMINI_ENDPOINT : '')
            || defaultBaseUrl
    );

    if (!apiKey || !baseUrl) {
        const error = new Error('Voice transcription provider configuration is incomplete.');
        error.code = 'VOICE_PROVIDER_UNAVAILABLE';
        throw error;
    }

    return {
        provider,
        apiKey,
        baseUrl,
        model: provider === 'gemini'
            ? (() => {
                const configured = readString(voice.transcription_model, '');
                // Magento's historical default is an OpenAI model. Gemini
                // must use an audio-capable Gemini model instead.
                if (!configured || /^gpt-/i.test(configured) || /^gemini-1\.5-/i.test(configured)) {
                    return readString(
                        process.env.GEMINI_TRANSCRIPTION_MODEL,
                        readString(config.model, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite')
                    );
                }
                return configured;
            })()
            : readString(voice.transcription_model, 'gpt-4o-mini-transcribe'),
        timeoutMs: clampInteger(voice.timeout_ms, 120000, 10000, 180000)
    };
}

function extensionForMimeType(mimeType) {
    switch (mimeType) {
        case 'audio/ogg': return 'ogg';
        case 'audio/mp4':
        case 'audio/x-m4a': return 'm4a';
        case 'audio/aac': return 'aac';
        case 'audio/mpeg': return 'mp3';
        case 'audio/wav':
        case 'audio/x-wav': return 'wav';
        default: return 'webm';
    }
}

export function normalizeVoicePayload(payload = {}, voiceConfig = {}) {
    const rawMimeType = readString(payload.mime_type).toLowerCase().split(';')[0];
    const mimeType = MIME_ALIASES.get(rawMimeType) || rawMimeType;
    const audio = String(payload.audio || '').replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '');
    const durationSeconds = Number(payload.duration_seconds);
    const maxAudioBytes = clampInteger(voiceConfig.max_audio_bytes, 4194304, 262144, 4194304);
    const maxDurationSeconds = clampInteger(voiceConfig.max_duration_seconds, 120, 5, 300);

    if (!ALLOWED_MIME_TYPES.has(mimeType) && !MIME_ALIASES.has(rawMimeType)) {
        throw Object.assign(new Error('This audio format is not supported.'), { code: 'VOICE_UNSUPPORTED_FORMAT' });
    }
    if (!audio || audio.length > MAX_BASE64_LENGTH || !/^[a-z0-9+/]+={0,2}$/i.test(audio)) {
        throw Object.assign(new Error('The recording could not be read.'), { code: 'VOICE_INVALID_AUDIO' });
    }
    const bytes = Buffer.from(audio, 'base64');
    if (!bytes.length || bytes.length > maxAudioBytes) {
        throw Object.assign(new Error('The recording is larger than this store allows.'), { code: 'VOICE_AUDIO_TOO_LARGE' });
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxDurationSeconds) {
        throw Object.assign(new Error('The recording is longer than this store allows.'), { code: 'VOICE_DURATION_EXCEEDED' });
    }

    return { mimeType, bytes, durationSeconds };
}

function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

async function providerError(response) {
    const raw = await response.text();
    let message = raw;
    try {
        const payload = JSON.parse(raw);
        message = payload?.error?.message || payload?.message || raw;
    } catch {}
    const error = new Error(message || `Voice provider returned HTTP ${response.status}.`);
    error.status = response.status;
    return error;
}

/**
 * Transcribe a temporary audio buffer. This function intentionally never
 * persists, logs or returns audio; the only output is short plain text.
 */
export async function transcribeVoice({ payload, config = {} } = {}) {
    const voice = config.voice && typeof config.voice === 'object' ? config.voice : {};
    if (voice.enabled === false) {
        throw Object.assign(new Error('Voice dictation is disabled.'), { code: 'VOICE_DISABLED' });
    }

    const audio = normalizeVoicePayload(payload, voice);
    const provider = providerSettings(config);
    if (provider.provider === 'gemini') {
        const timeout = createTimeoutSignal(provider.timeoutMs);
        try {
            const response = await fetch(geminiGenerateContentUrl(provider.baseUrl, provider.model), {
                method: 'POST',
                headers: {
                    'x-goog-api-key': provider.apiKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        role: 'user',
                        parts: [
                            { text: 'Transcribe the speech exactly. Return only the transcript text, without commentary.' },
                            { inlineData: { mimeType: audio.mimeType, data: audio.bytes.toString('base64') } }
                        ]
                    }],
                    generationConfig: { maxOutputTokens: 4096 }
                }),
                signal: timeout.signal
            });
            if (!response.ok) throw await providerError(response);
            const result = await response.json();
            const text = String(result?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('') || '')
                .replace(/\s+/g, ' ').trim();
            if (!text) throw Object.assign(new Error('No speech was detected. Please try again.'), { code: 'VOICE_EMPTY_TRANSCRIPT' });
            return text.slice(0, 8000);
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw Object.assign(new Error('Voice transcription timed out. Please try again.'), { code: 'VOICE_TIMEOUT' });
            }
            throw error;
        } finally {
            timeout.dispose();
            audio.bytes.fill(0);
        }
    }

    const form = new FormData();
    form.append('model', provider.model);
    form.append('response_format', 'json');
    form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), `dictation.${extensionForMimeType(audio.mimeType)}`);
    const timeout = createTimeoutSignal(provider.timeoutMs);

    try {
        const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${provider.apiKey}`,
                Accept: 'application/json'
            },
            body: form,
            signal: timeout.signal
        });
        if (!response.ok) throw await providerError(response);

        const result = await response.json();
        const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            throw Object.assign(new Error('No speech was detected. Please try again.'), { code: 'VOICE_EMPTY_TRANSCRIPT' });
        }
        return text.slice(0, 8000);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw Object.assign(new Error('Voice transcription timed out. Please try again.'), { code: 'VOICE_TIMEOUT' });
        }
        throw error;
    } finally {
        timeout.dispose();
        // Clear the Buffer reference as soon as the request completes.
        audio.bytes.fill(0);
    }
}
