import { buildAgentSystemInstruction } from '../orchestration/agent-system-guidance.js';
import { TOOL_DEFINITIONS } from '../tools/tool-registry.js';

const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

// Voice transcription can be imperfect. Restrict Live Voice to verified read
// operations; any store mutation remains in the regular text UI where the
// customer sees a reviewable form and explicit confirmation.
const LIVE_VOICE_TOOL_NAMES = new Set([
    'searchProducts',
    'compareProducts',
    'getProductAvailability',
    'listCategories',
    'searchStoreKnowledge',
    'getRecentOrders',
    'getGuestOrders',
    'getGuestOrderDetails',
    'getOrderDetails',
    'getOrderFulfillment'
]);

export function liveVoiceToolDefinitions() {
    return TOOL_DEFINITIONS
        .filter((definition) => LIVE_VOICE_TOOL_NAMES.has(definition.name))
        .filter((definition) => definition.policy.risk === 'read')
        .filter((definition) => definition.policy.providers.includes('openai'))
        .map(({ name, description, parameters }) => ({
            type: 'function',
            name,
            description,
            parameters
        }));
}

export function isLiveVoiceTool(name) {
    return LIVE_VOICE_TOOL_NAMES.has(String(name || ''));
}

function readString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(numeric), maximum));
}

function providerFailure(response, body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        detail = String(parsed?.error?.message || parsed?.message || '');
    } catch {
        // A provider response body is not customer-safe and is deliberately
        // not sent to the browser or logged with credentials.
    }
    const error = new Error(detail || `OpenAI Realtime returned HTTP ${response.status}.`);
    error.code = 'VOICE_LIVE_PROVIDER_UNAVAILABLE';
    error.status = response.status;
    return error;
}

/**
 * Obtain a browser-safe, short-lived Realtime credential.  The long-lived
 * OpenAI API key stays in the encrypted Magento → Node config snapshot.
 */
export async function createLiveVoiceClientSecret({ config = {}, fetchImpl = fetch } = {}) {
    const live = config?.voice?.live && typeof config.voice.live === 'object'
        ? config.voice.live
        : {};
    if (live.enabled !== true) {
        throw Object.assign(new Error('Live Voice is disabled for this store.'), { code: 'VOICE_LIVE_DISABLED' });
    }

    const apiKey = readString(live.api_key);
    const model = readString(live.model, 'gpt-realtime-1.5');
    if (!apiKey || !OPENAI_MODEL_PATTERN.test(model)) {
        throw Object.assign(
            new Error('Live Voice requires a valid OpenAI Realtime configuration.'),
            { code: 'VOICE_LIVE_PROVIDER_UNAVAILABLE' }
        );
    }

    const maximumDuration = boundedInteger(live.max_duration_seconds, 600, 30, 1800);
    const response = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            session: {
                type: 'realtime',
                model,
                // Keep text transcripts available for accessibility and for
                // the normal chat history after the voice call ends.
                audio: {
                    input: {
                        transcription: { model: 'gpt-4o-mini-transcribe' }
                    }
                },
                instructions: `${buildAgentSystemInstruction({ extendedTools: true })}\n\nLIVE VOICE RULES: Speak naturally and concisely. Use only the tools provided in this voice session. Voice mode may read verified store data, but never performs cart, address, order, or account mutations. Ask the shopper to use text chat for any action that changes data.`,
                tools: liveVoiceToolDefinitions()
            }
        })
    });
    const body = await response.text();
    if (!response.ok) throw providerFailure(response, body);

    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        throw Object.assign(new Error('OpenAI Realtime returned an invalid session response.'), {
            code: 'VOICE_LIVE_PROVIDER_UNAVAILABLE'
        });
    }
    const clientSecret = readString(payload?.value || payload?.client_secret?.value);
    if (!clientSecret) {
        throw Object.assign(new Error('OpenAI Realtime did not provide a browser session credential.'), {
            code: 'VOICE_LIVE_PROVIDER_UNAVAILABLE'
        });
    }

    return {
        clientSecret,
        expiresAt: Math.max(0, Number(payload?.expires_at || payload?.client_secret?.expires_at) || 0),
        model,
        maximumDuration
    };
}
