import crypto from 'node:crypto';

const ACTION_POLICIES = Object.freeze({
    guest_order_request_otp: { limit: 5, windowMs: 15 * 60 * 1000 },
    guest_order_verify_otp: { limit: 10, windowMs: 10 * 60 * 1000 },
    support_portal_load: { limit: 30, windowMs: 60 * 1000 },
    support_ticket_create: { limit: 5, windowMs: 60 * 60 * 1000 },
    support_subscribe: { limit: 60, windowMs: 60 * 1000 },
    support_typing: { limit: 180, windowMs: 60 * 1000 },
    support_message_edit: { limit: 30, windowMs: 60 * 1000 },
    support_message_delete: { limit: 30, windowMs: 60 * 1000 },
    new_chat: { limit: 10, windowMs: 60 * 1000 },
    reset_guest_history: { limit: 5, windowMs: 60 * 1000 },
    list_conversations: { limit: 30, windowMs: 60 * 1000 },
    load_conversation: { limit: 30, windowMs: 60 * 1000 },
    delete_conversation: { limit: 15, windowMs: 60 * 1000 },
    rename_conversation: { limit: 20, windowMs: 60 * 1000 },
    cancel_chat: { limit: 30, windowMs: 60 * 1000 },
    cart_add_result: { limit: 60, windowMs: 60 * 1000 },
    cart_mutation_result: { limit: 60, windowMs: 60 * 1000 },
    voice_transcribe: { limit: 12, windowMs: 60 * 1000 },
    live_voice_session: { limit: 6, windowMs: 60 * 1000 },
    live_voice_save_turn: { limit: 24, windowMs: 60 * 1000 },
    live_voice_tool_call: { limit: 30, windowMs: 60 * 1000 },
    chat: { limit: 30, windowMs: 60 * 1000 },
    load_product_page: { limit: 30, windowMs: 60 * 1000 },
    order_address_update: { limit: 5, windowMs: 60 * 1000 },
    customer_address_update: { limit: 5, windowMs: 60 * 1000 }
});

const OTP_EMAIL_POLICY = Object.freeze({ limit: 3, windowMs: 15 * 60 * 1000 });
const OTP_NETWORK_POLICY = Object.freeze({ limit: 20, windowMs: 15 * 60 * 1000 });
const OTP_GLOBAL_POLICY = Object.freeze({ limit: 250, windowMs: 15 * 60 * 1000 });

export async function guardWebSocketAction(runtime, client, action, payload = {}) {
    const normalizedAction = String(action || '');
    const policy = ACTION_POLICIES[normalizedAction];
    if (!policy) {
        return { allowed: false, retryAfterMs: 0, reason: 'unknown_action' };
    }

    const identity = String(client?.rateLimitKey || client?.sessionId || 'unknown');
    const identityAdmission = await runtime.consumeRateLimit(
        `${identity}:ws-action:${normalizedAction}`,
        policy
    );
    if (!identityAdmission.allowed || normalizedAction !== 'guest_order_request_otp') {
        return identityAdmission;
    }

    const email = String(payload?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return identityAdmission;
    }

    const emailKey = crypto.createHash('sha256').update(email, 'utf8').digest('hex');
    const networkKey = String(client?.networkRateLimitKey || 'unknown');
    const admissions = await Promise.all([
        runtime.consumeRateLimit(`email:${emailKey}:otp-request`, OTP_EMAIL_POLICY),
        runtime.consumeRateLimit(`${networkKey}:otp-request`, OTP_NETWORK_POLICY),
        runtime.consumeRateLimit('global:otp-request', OTP_GLOBAL_POLICY)
    ]);
    const blocked = admissions.find((admission) => !admission.allowed);
    return blocked || identityAdmission;
}

export { ACTION_POLICIES };
