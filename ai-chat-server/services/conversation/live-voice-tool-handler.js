import { executeRegisteredMagentoTool } from '../tools/magento-tool-executor.js';
import { isLiveVoiceTool } from '../media/live-voice-session.js';

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

function safeArguments(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
}

function safeCallId(value) {
    const id = String(value || '');
    return CALL_ID_PATTERN.test(id) ? id : '';
}

function customerMessage(result) {
    if (!result || typeof result !== 'object') return { status: 'error', message: 'The store lookup could not be completed.' };
    // Results travel only back to the Realtime model—not to HTML—and this
    // defensive shallow clone excludes accidental transport metadata.
    return result;
}

/** Execute an allowlisted, read-only Magento tool for a Live Voice function call. */
export async function handleLiveVoiceToolCall({ ws, data, client, runtime, getConfig, attachRequestId }) {
    const requestId = String(data?.request_id || '').slice(0, 120);
    const callId = safeCallId(data?.call_id);
    const name = String(data?.name || '');
    const send = (payload) => ws.send(attachRequestId({ ...payload, request_id: requestId }, requestId));
    if (!callId || !isLiveVoiceTool(name)) {
        send({
            type: 'live_voice_tool_result',
            call_id: callId,
            result: { status: 'error', message: 'This action is unavailable in Live Voice. Use text chat for account changes.' }
        });
        return;
    }

    try {
        const config = await getConfig(runtime, client?.catalogScope?.storeCode || '');
        const result = await executeRegisteredMagentoTool(name, safeArguments(data?.arguments), {
            magentoOauth: config.magento_oauth,
            magentoBaseUrl: config.magento_base_url,
            runtime,
            customerId: client?.customerId || null,
            guestOrderAccess: {
                sessionId: client?.sessionId || '',
                token: client?.guestOrderAccessToken || '',
                email: client?.guestOrderEmail || '',
                expiresAt: client?.guestOrderAccessExpiresAt || 0
            },
            catalogScope: client?.catalogScope || null,
            shopperMessage: String(data?.shopper_text || '').slice(0, 4000)
        });
        send({ type: 'live_voice_tool_result', call_id: callId, result: customerMessage(result) });
    } catch {
        send({
            type: 'live_voice_tool_result',
            call_id: callId,
            result: { status: 'error', message: 'The store lookup could not be completed. Please try again.' }
        });
    }
}
