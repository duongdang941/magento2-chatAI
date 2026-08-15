import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { guardWebSocketAction } from './services/security/websocket-action-guard.js';
import {
    addConfiguredWebSocketOrigins,
    admitDistributedWebSocketConnection,
    admitLocalWebSocketConnection,
    configuredWebSocketOrigins,
    createDistributedWebSocketConnectionAdmission,
    createWebSocketConnectionAdmission,
    installWebSocketHeartbeat
} from './services/security/websocket-security.js';
import {
    acceptsClientContract,
    installGatewayEventContract
} from './services/conversation/message-contract.js';
import { createSupportBroadcaster } from './services/support/support-broadcaster.js';
import { createAddressUpdateAdmission } from './services/customer/address-update-admission.js';
import { guestOrderAccessCacheKey, supportEmailVerificationCacheKey, normalizeGuestOrderAccessExpiry, hasActiveGuestOrderAccess, hasActiveSupportEmailVerification, guestOrderAccessState, guestOrderAccessNeedsVerification } from './services/security/guest-access.js';

// Services
import { getAiConfig, getAiConfigSnapshot } from './services/configuration/config-service.js';
import { getOrchestrator } from './services/orchestration/orchestrator-factory.js';
import { summarizeError } from './services/gateway/error-summary.js';
import { getGatewayRuntime } from './services/gateway/gateway-runtime.js';
import { getGatewayRuntimeLimits } from './services/gateway/runtime-limits.js';
import { GatewayMetrics } from './services/gateway/gateway-metrics.js';
import { verifyWebSocketTicket } from './services/security/ws-ticket.js';
import { loadCatalogPage } from './services/catalog/catalog-page-loader.js';
import {
    buildCatalogProductsPayload,
    verifyCatalogPageToken
} from './services/catalog/catalog-pagination.js';
import { replaceProductPart } from './services/catalog/product-presentation.js';
import * as db from './services/gateway/db-service.js';
import { GuestSessionHistory } from './services/conversation/guest-session-history.js';
import {
    buildUserMessageDescriptor,
    recordOutboundAssistantPart,
    validateImageParts
} from './services/conversation/message-parts.js';
import {
    buildInterruptedAssistantPayload
} from './services/conversation/interrupted-response.js';
import { BrowserCartBridge } from './services/customer/browser-cart-bridge.js';
import { routeVoiceAction } from './services/conversation/voice-action-router.js';
import { guestOrderAction } from './services/customer/guest-order-client.js';
import { executeCustomerOrderAction } from './services/customer/customer-order-client.js';
import { executeCustomerAddressAction } from './services/customer/customer-address-client.js';
import { normalizeCustomerAddressArguments, normalizeOrderAddressArguments } from './services/customer/customer-order-tool-arguments.js';
import {
    isCustomerAddressChangeRequest,
    isOrderAddressChangeRequest,
    normalizeOrderAddressFormPart
} from './services/customer/order-address-form.js';
import { registerGatewayHttpRoutes } from './services/gateway/gateway-http-routes.js';
import { revokeCustomerSockets } from './services/security/session-revoker.js';
import {
    createSupportCase,
    getSupportConversationState,
    listSupportCases,
    mutateSupportMessage
} from './services/gateway/assistant-service-client.js';
import { createConversationHistoryCodec } from './services/conversation/conversation-history.js';
import {
    attachRequestId,
    createActiveRunController,
    isAbortError
} from './services/conversation/active-run-controller.js';
import {
    clearPendingVerificationAction,
    consumePendingVerificationAction,
    rememberPendingVerificationAction
} from './services/conversation/pending-verification-action.js';
import { createHistoryMessagePreparer } from './services/conversation/history-message-preparer.js';
import { guestHistoryIdentity, guestHistoryMode } from './services/conversation/guest-history.js';
import { stopGateway } from './services/gateway/graceful-shutdown.js';
import { createConnectionLifecycle } from './services/gateway/connection-lifecycle.js';
import { createGatewayServer } from './services/gateway/gateway-server.js';
import { admitImageRequest } from './services/media/image-admission.js';
import { reportAssistantCompletion } from './services/analytics/commerce-events.js';
import { reportGuardrailDecision } from './services/policy/guardrail-audit.js';
const app = express();
const port = process.env.PORT || 3001;
const runtime = getGatewayRuntime();
const metrics = new GatewayMetrics();
const guestSessionHistory = new GuestSessionHistory(runtime);
const {
    maxMessagesPerMinute: MAX_MESSAGES_PER_MINUTE,
    maxProductPageRequestsPerMinute: MAX_PRODUCT_PAGE_REQUESTS_PER_MINUTE,
    maxAddressUpdatesPerMinute: MAX_ADDRESS_UPDATES_PER_MINUTE,
    maxAddressUpdatesPerHour: MAX_ADDRESS_UPDATES_PER_HOUR,
    maxModelHistoryMessages: MAX_MODEL_HISTORY_MESSAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
    maxWebSocketPayloadBytes: MAX_WS_PAYLOAD_BYTES,
    maxWebSocketEncodedImageBytes: MAX_WS_ENCODED_IMAGE_BYTES,
    maxConcurrentModelRequests: MAX_CONCURRENT_MODEL_REQUESTS,
    maxQueueDepth: MAX_QUEUE_DEPTH,
    maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    modelLeaseMs: MODEL_LEASE_MS,
    addressUpdateLockMs: ADDRESS_UPDATE_LOCK_MS
} = getGatewayRuntimeLimits();
const GUEST_ORDER_ACCESS_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORT_EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000;
const PENDING_VERIFICATION_ACTION_TTL_MS = 15 * 60 * 1000;
const CUSTOMER_ACTION_FORM_TTL_MS = 15 * 60 * 1000;
const {
    buildAssistantStoragePayload,
    buildConversationTitle,
    extractTextFromParts,
    guestHistoryMessagesFromClient,
    normalizeStoredAssistantMessage,
    trimHistoryForModel
} = createConversationHistoryCodec({ maxModelHistoryMessages: MAX_MODEL_HISTORY_MESSAGES });

// ==================== WEBSOCKET SERVER ====================

const server = createGatewayServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });
const allowedWebSocketOrigins = configuredWebSocketOrigins();
installWebSocketHeartbeat(wss, process.env.WS_HEARTBEAT_INTERVAL_MS);
const websocketAdmission = createWebSocketConnectionAdmission();
const distributedWebsocketAdmission = createDistributedWebSocketConnectionAdmission({ runtime });

// Connection tracking
const clientData = new Map(); // ws → { customerId, customerName, sessionId }
const addressUpdateAdmission = createAddressUpdateAdmission({
    runtime,
    getConfig: getAiConfig,
    defaults: {
        perMinute: MAX_ADDRESS_UPDATES_PER_MINUTE,
        perHour: MAX_ADDRESS_UPDATES_PER_HOUR,
        lockMs: ADDRESS_UPDATE_LOCK_MS
    }
});
const prepareHistoryMessages = createHistoryMessagePreparer({
    runtime,
    normalizeStoredAssistantMessage,
    hasActiveSupportEmailVerification,
    listSupportCases,
    supportPortalIdentity,
    hasActiveGuestOrderAccess,
    addressUpdateAdmission
});

const {
    broadcastSupportMessage,
    broadcastSupportMutation,
    broadcastSupportTypingToCustomers,
    broadcastSupportTypingToAdmins,
    broadcastSupportMessageToAdmins,
    broadcastSupportMode
} = createSupportBroadcaster({ clientData, isSocketOpen });

// Create the run controller before registering HTTP routes. Route callbacks
// close over these functions and must never evaluate the lexical binding while
// it is still in its temporal dead zone during server startup.
const {
    cancelActiveRun,
    clearActiveRun,
    createActiveRun,
    isRunCancelled,
    notifyCancelled
} = createActiveRunController({ isSocketOpen });

registerGatewayHttpRoutes({
    app,
    runtime,
    metrics,
    db,
    websocketConnections: () => wss.clients.size,
    broadcastSupportMessage,
    broadcastSupportMutation,
    broadcastSupportMode,
    onConfigAccepted: (snapshot) => addConfiguredWebSocketOrigins(allowedWebSocketOrigins, snapshot),
    revokeSession: ({ sessionHash, customerId }) => revokeCustomerSockets({
        clientData,
        sessionHash,
        customerId,
        isSocketOpen,
        cancelActiveRun,
        rejectBrowserCart: (socket) => browserCartBridge.rejectAll(socket)
    })
});

async function supportConversationState(client, conversationId) {
    try {
        const state = await getSupportConversationState({
            customerId: client?.customerId || 0,
            guestId: client?.customerId ? '' : guestHistoryIdentity(client),
            catalogScope: client?.catalogScope || null
        }, conversationId, client?.catalogScope || null);
        return {
            active: state?.active === true,
            closed: state?.closed === true,
            isSupport: state?.is_support === true,
            status: String(state?.status || '').slice(0, 24),
            agentLabel: String(state?.agent_label || '').slice(0, 80)
        };
    } catch (error) {
        console.warn('[Support] Could not read live-chat state:', summarizeError(error));
        return { active: false, closed: false, isSupport: false, status: '', agentLabel: '' };
    }
}

const browserCartBridge = new BrowserCartBridge({ isSocketOpen });

function guestUserHistoryMessage(currentUser, data) {
    const imageParts = currentUser.parts.filter((part) => part?.inline_data);
    const uploadedImages = Array.isArray(data.images) ? data.images : [];
    return {
        role: 'user',
        content: currentUser.displayText || currentUser.text || '',
        attachments: imageParts.map((part, index) => ({
            name: String(uploadedImages[index]?.name || data.image?.name || 'uploaded-image').slice(0, 120),
            mime_type: part.inline_data.mime_type,
            data: part.inline_data.data
        }))
    };
}

function guestAssistantHistoryMessage(parts, metadata = {}) {
    return {
        role: 'assistant',
        content: extractTextFromParts(parts),
        parts,
        ...(metadata.interrupted === true ? {
            interrupted: true,
            stopped_after_seconds: Math.max(0, Math.floor(Number(metadata.stopped_after_seconds) || 0))
        } : {})
    };
}

async function restoreGuestHistoryFromClient(history, guestId, conversationId) {
    for (const message of guestHistoryMessagesFromClient(history)) {
        await guestSessionHistory.append(guestId, conversationId, message);
    }
}

function isSocketOpen(ws) {
    return ws.readyState === ws.OPEN;
}

const connectionLifecycle = createConnectionLifecycle({
    clientData,
    wss,
    metrics,
    cancelActiveRun,
    browserCartBridge,
    broadcastSupportTypingToCustomers,
    broadcastSupportTypingToAdmins
});

function broadcastGuestSession(origin, client, payload) {
    const guestId = guestHistoryIdentity(client);
    if (!guestId) return;
    for (const socket of wss.clients) {
        if (socket === origin || !isSocketOpen(socket)) continue;
        const candidate = clientData.get(socket);
        if (!candidate || candidate.customerId || guestHistoryIdentity(candidate) !== guestId) continue;
        socket.send(JSON.stringify(payload));
    }
}

async function broadcastGuestConversation(origin, client, mode, conversationId) {
    try {
        const page = mode === 'database'
            ? await db.loadGuestMessages(conversationId, guestHistoryIdentity(client), null, client.catalogScope || null)
            : await guestSessionHistory.loadMessages(client.sessionId, conversationId);
        const messages = await prepareHistoryMessages(page.messages || [], client, conversationId);
        broadcastGuestSession(origin, client, {
            type: 'guest_history_sync',
            conversation_id: conversationId,
            messages
        });
    } catch (error) {
        console.warn('[Chat] Guest cross-tab history sync failed:', summarizeError(error));
    }
}


async function hydrateSupportEmailVerification(client) {
    if (!client?.sessionId) return false;
    if (hasActiveSupportEmailVerification(client)) return true;

    const cacheKey = supportEmailVerificationCacheKey(client.sessionId);
    const cached = await runtime.getAuthCache(cacheKey);
    const accessToken = String(cached?.accessToken || '');
    const email = String(cached?.email || '');
    const expiresAt = Number(cached?.expiresAt);
    const valid = /^[a-f0-9]{64}$/i.test(accessToken)
        && /^\S+@\S+\.\S+$/.test(email)
        && Number.isFinite(expiresAt)
        && expiresAt > Date.now();

    if (!valid) {
        if (cached) await runtime.deleteAuthCache(cacheKey);
        return false;
    }

    client.supportEmail = email.toLowerCase();
    client.supportEmailAccessToken = accessToken;
    client.supportEmailVerifiedUntil = expiresAt;
    return true;
}

async function rememberSupportEmailVerification(client, email, token, reportedExpiry) {
    if (!client?.sessionId) return false;
    const now = Date.now();
    const normalizedExpiry = normalizeGuestOrderAccessExpiry(reportedExpiry);
    const expiresAt = Math.min(
        normalizedExpiry > now ? normalizedExpiry : now + SUPPORT_EMAIL_VERIFICATION_TTL_MS,
        now + SUPPORT_EMAIL_VERIFICATION_TTL_MS
    );
    const ttlMs = expiresAt - now;
    if (ttlMs <= 0) return false;

    client.supportEmail = String(email).trim().toLowerCase();
    client.supportEmailAccessToken = String(token);
    client.supportEmailVerifiedUntil = expiresAt;
    await runtime.setAuthCache(supportEmailVerificationCacheKey(client.sessionId), {
        email: client.supportEmail,
        accessToken: client.supportEmailAccessToken,
        expiresAt
    }, ttlMs);
    return true;
}

function supportPortalIdentity(client) {
    if (!hasActiveSupportEmailVerification(client)) return null;
    return {
        customerId: client.customerId || null,
        guestId: client.customerId ? null : guestHistoryIdentity(client),
        verifiedEmail: client.supportEmail,
        verificationToken: client.supportEmailAccessToken,
        verificationSessionId: client.sessionId,
        catalogScope: client.catalogScope || null
    };
}

async function sendSupportPortal(ws, client, formId = '') {
    const identity = supportPortalIdentity(client);
    if (!identity) {
        ws.send(JSON.stringify({
            type: 'support_portal_result',
            form_id: String(formId || ''),
            result: { status: 'requires_customer_action', reason: 'guest_access_required', cases: [] }
        }));
        return;
    }

    let result;
    try {
        result = await listSupportCases(identity);
    } catch (error) {
        console.warn('[Support] Could not load customer tickets:', summarizeError(error));
        result = { status: 'error', message: 'Your support tickets could not be loaded.', cases: [] };
    }
    ws.send(JSON.stringify({ type: 'support_portal_result', form_id: String(formId || ''), result }));
}

async function clearSupportEmailVerification(client) {
    if (!client) return;
    client.supportEmail = '';
    client.supportEmailAccessToken = '';
    client.supportEmailVerifiedUntil = 0;
    if (client.sessionId) {
        await runtime.deleteAuthCache(supportEmailVerificationCacheKey(client.sessionId));
    }
}


async function hydrateGuestOrderAccess(client) {
    if (!client || client.customerId || !client.sessionId) {
        return false;
    }

    if (client.guestOrderAccessToken) {
        if (hasActiveGuestOrderAccess(client)) return true;
        await clearGuestOrderAccess(client);
    }

    const cacheKey = guestOrderAccessCacheKey(client.sessionId);
    const cached = await runtime.getAuthCache(cacheKey);
    const accessToken = String(cached?.accessToken || '');
    const email = String(cached?.email || '');
    const expiresAt = Number(cached?.expiresAt);
    const valid = /^[a-f0-9]{64}$/i.test(accessToken)
        && /^\S+@\S+\.\S+$/.test(email)
        && Number.isFinite(expiresAt)
        && expiresAt > Date.now();

    if (!valid) {
        if (cached) await runtime.deleteAuthCache(cacheKey);
        return false;
    }

    client.guestOrderEmail = email.toLowerCase();
    client.guestOrderAccessToken = accessToken;
    client.guestOrderAccessExpiresAt = expiresAt;
    return true;
}

async function rememberGuestOrderAccess(client, email, token, expiresInSeconds, expiresAtSeconds) {
    if (!client?.sessionId) return false;
    const now = Date.now();
    const reportedExpiresAt = normalizeGuestOrderAccessExpiry(expiresAtSeconds);
    const hasReportedExpiry = reportedExpiresAt > 0;
    const fallbackExpiresAt = now + Math.max(
        1000,
        Math.min(GUEST_ORDER_ACCESS_MAX_TTL_MS, Number(expiresInSeconds || 0) * 1000 || GUEST_ORDER_ACCESS_MAX_TTL_MS)
    );
    const expiresAt = Math.min(
        now + GUEST_ORDER_ACCESS_MAX_TTL_MS,
        hasReportedExpiry ? reportedExpiresAt : fallbackExpiresAt
    );
    const ttlMs = expiresAt - now;
    if (ttlMs <= 0) return false;

    client.guestOrderEmail = String(email).trim().toLowerCase();
    client.guestOrderAccessToken = String(token);
    client.guestOrderAccessExpiresAt = expiresAt;
    await runtime.setAuthCache(guestOrderAccessCacheKey(client.sessionId), {
        email: client.guestOrderEmail,
        accessToken: client.guestOrderAccessToken,
        expiresAt
    }, ttlMs);
    return true;
}

async function clearGuestOrderAccess(client) {
    if (!client) return;
    client.guestOrderEmail = '';
    client.guestOrderAccessToken = '';
    client.guestOrderAccessExpiresAt = 0;
    if (client.sessionId) {
        await runtime.deleteAuthCache(guestOrderAccessCacheKey(client.sessionId));
    }
}

async function notifyGuestOrderAccessReset(origin, client) {
    await clearGuestOrderAccess(client);
    if (isSocketOpen(origin)) {
        origin.send(JSON.stringify(guestOrderAccessState(client, 'email')));
    }
    broadcastGuestSession(origin, client, guestOrderAccessState(client, 'email'));
}

wss.on('connection', async (ws, req) => {
    if (!admitLocalWebSocketConnection(ws, req, {
        admission: websocketAdmission,
        currentConnections: wss.clients.size - 1,
        allowedOrigins: allowedWebSocketOrigins,
        metrics
    })) return;

    ws.isAlive = true;
    installGatewayEventContract(ws);
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ticket = url.searchParams.get('ticket');
    let auth;

    try {
        auth = ticket ? verifyWebSocketTicket(ticket) : null;
        if (!auth) {
            throw new Error('A valid WebSocket ticket is required.');
        }
        if (auth.source === 'ticket' && !await runtime.claimWebSocketTicket(auth.ticketId, 60)) {
            throw new Error('WebSocket ticket was already used.');
        }
    } catch (error) {
        metrics.increment('websocket_rejected', { reason: 'invalid_ticket' });
        ws.close(1008, 'Invalid connection ticket');
        return;
    }

    if (!await admitDistributedWebSocketConnection(ws, req, distributedWebsocketAdmission, metrics)) return;

    const customerId = auth.customerId || null;
    const supportAdmin = auth.role === 'support_admin';

    clientData.set(ws, {
        role: supportAdmin ? 'support_admin' : 'customer',
        adminId: supportAdmin ? Number(auth.adminId) : null,
        adminName: supportAdmin ? String(auth.adminName || 'Support team') : '',
        customerId,
        customerName: auth.customerName || '',
        sessionId: auth.sessionId,
        guestHistoryId: auth.guestHistoryId || '',
        // For ticket auth this is an encrypted, one-minute Magento checkout
        // session claim, available only after the single-use ticket is verified.
        sessionCookie: auth.sessionCookie,
        // This is read only from a Magento-signed WebSocket ticket. It is
        // never accepted as a field in a browser message or model tool call.
        catalogScope: auth.catalogScope || null,
        pageContext: auth.pageContext || null,
        // Stable across reconnects so a new short-lived connection ticket
        // cannot reset chat or mutation throttles.
        rateLimitKey: customerId ? `customer:${customerId}` : `session:${auth.sessionId}`,
        networkRateLimitKey: `network:${crypto.createHash('sha256')
            .update(String(req.socket?.remoteAddress || 'unknown'), 'utf8')
            .digest('hex')}`,
        token: null,
        guestOrderEmail: '',
        guestOrderAccessToken: '',
        guestOrderAccessExpiresAt: 0,
        supportEmail: '',
        supportEmailAccessToken: '',
        supportEmailVerifiedUntil: 0,
        pendingVerificationAction: null,
        supportConversationId: 0,
        activeSupportConversationId: 0,
        authSource: auth.source || 'guest'
    });
    const client = clientData.get(ws);
    let guestAccessRestored = false;
    if (!supportAdmin && !customerId) {
        try {
            guestAccessRestored = await hydrateGuestOrderAccess(client);
        } catch (error) {
            console.warn('[Guest orders] Could not restore guest order access:', summarizeError(error));
        }
    }
    if (!supportAdmin) {
        try {
            await hydrateSupportEmailVerification(client);
        } catch (error) {
            console.warn('[Support] Could not restore verified email access:', summarizeError(error));
        }
    }
    metrics.increment('websocket_connected', { auth: auth.source || 'ticket' });
    console.log(`Client connected [auth=${auth.source || 'guest'}, total=${wss.clients.size}]`);

    // Send auth status to client
    ws.send(JSON.stringify({
        type: 'auth',
        isLoggedIn: !!customerId,
        customerId,
        customerName: auth.customerName || '',
        role: supportAdmin ? 'support_admin' : 'customer',
        historyAvailable: true,
        historyScope: customerId ? `customer:${customerId}` : `guest:${auth.guestHistoryId}`
    }));
    if (!supportAdmin && !customerId) {
        // Explicitly send both states. This prevents an old per-tab snapshot
        // from continuing to display “verified” after another tab starts a
        // fresh OTP cycle or after the gateway has restarted.
        ws.send(JSON.stringify(guestOrderAccessState(client, guestAccessRestored ? 'verified' : 'email')));
    }

    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw);
            if (!acceptsClientContract(data)) {
                ws.send(JSON.stringify({
                    type: 'error',
                    content: 'This chat client contract is not supported. Reload the storefront.'
                }));
                return;
            }
            const client = clientData.get(ws);
            if (client?.role === 'support_admin'
                && !['support_subscribe', 'support_typing'].includes(String(data.action || ''))) {
                ws.send(JSON.stringify({
                    type: 'error',
                    content: 'This administrator socket is limited to live support.'
                }));
                return;
            }
            const actionAdmission = await guardWebSocketAction(runtime, client, data.action, data);
            if (!actionAdmission.allowed) {
                metrics.increment('rate_limited', { action: String(data.action || 'unknown') });
                ws.send(JSON.stringify({
                    type: 'busy',
                    error_code: 'RATE_LIMITED',
                    recoverable: true,
                    retry_after: Math.max(1, Math.ceil(actionAdmission.retryAfterMs / 1000)),
                    content: 'You are sending requests too quickly. Please wait a moment.'
                }));
                return;
            }

            // ---- ACTION ROUTER ----
            switch (data.action) {

                case 'support_subscribe': {
                    if (client?.role !== 'support_admin') break;
                    client.supportConversationId = Math.max(0, Math.trunc(Number(data.conversation_id) || 0));
                    ws.send(JSON.stringify({
                        type: 'support_subscribed',
                        conversation_id: client.supportConversationId
                    }));
                    break;
                }

                case 'support_typing': {
                    const conversationId = Math.max(0, Math.trunc(Number(data.conversation_id) || 0));
                    if (conversationId < 1) break;
                    if (client?.role === 'support_admin') {
                        if (Number(client.supportConversationId) !== conversationId) break;
                        broadcastSupportTypingToCustomers({
                            conversationId,
                            typing: data.typing === true,
                            agentLabel: client.adminName
                        });
                        break;
                    }

                    if (Number(client.activeSupportConversationId) !== conversationId) {
                        const state = await supportConversationState(client, conversationId);
                        if (!state.isSupport || state.closed) break;
                        client.activeSupportConversationId = conversationId;
                    }
                    broadcastSupportTypingToAdmins({ conversationId, typing: data.typing === true });
                    break;
                }

                case 'support_message_edit':
                case 'support_message_delete': {
                    if (client?.role === 'support_admin') break;
                    const operation = data.action === 'support_message_delete' ? 'delete' : 'edit';
                    let result;
                    try {
                        result = await mutateSupportMessage({
                            customerId: client?.customerId || 0,
                            guestId: client?.customerId ? '' : guestHistoryIdentity(client),
                            catalogScope: client?.catalogScope || null
                        }, data.conversation_id, data.message_id, operation, data.content, client?.catalogScope || null);
                    } catch (error) {
                        result = {
                            status: 'error',
                            message: error.response?.data?.message || 'The support message could not be changed.'
                        };
                    }
                    ws.send(JSON.stringify({
                        type: 'support_message_mutation_result',
                        request_id: String(data.request_id || '').slice(0, 120),
                        conversation_id: Math.max(0, Math.trunc(Number(data.conversation_id) || 0)),
                        message_id: Math.max(0, Math.trunc(Number(data.message_id) || 0)),
                        operation,
                        ...result
                    }));
                    break;
                }

                case 'chat': {
                    const aiConfig = await getAiConfig(runtime);
                    const rateLimit = await runtime.consumeRateLimit(client.rateLimitKey, {
                        limit: aiConfig.rate_limits?.messages_per_minute || MAX_MESSAGES_PER_MINUTE,
                        windowMs: 60 * 1000
                    });
                    if (!rateLimit.allowed) {
                        metrics.increment('rate_limited');
                        ws.send(JSON.stringify({
                            type: 'busy',
                            error_code: 'RATE_LIMITED',
                            recoverable: true,
                            retry_after: Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000)),
                            content: 'You are sending messages too quickly. Please wait a moment.'
                        }));
                        return;
                    }

                    clearPendingVerificationAction(client);
                    await handleChat(ws, data, client, aiConfig);
                    break;
                }

                case 'load_product_page': {
                    await handleProductPage(ws, data, client);
                    break;
                }

                case 'cancel_chat': {
                    cancelActiveRun(ws, data.request_id || null);
                    break;
                }

                case 'cart_add_result':
                case 'cart_mutation_result': {
                    browserCartBridge.resolve(ws, data);
                    break;
                }

                case 'voice_transcribe':
                case 'live_voice_session':
                case 'live_voice_save_turn':
                case 'live_voice_tool_call': {
                    await routeVoiceAction({ ws, data, client, runtime, metrics, getConfig: getAiConfig, attachRequestId, db, guestSessionHistory, broadcastGuestConversation });
                    break;
                }

                case 'guest_order_request_otp': {
                    const purpose = data.purpose === 'support' ? 'support' : 'order';
                    if (client.customerId && purpose !== 'support') break;
                    const formId = String(data.form_id || '').slice(0, 120);
                    if (purpose === 'support') {
                        await clearSupportEmailVerification(client);
                    } else {
                        await clearGuestOrderAccess(client);
                        broadcastGuestSession(ws, client, guestOrderAccessState(client, 'email'));
                    }
                    let result;
                    try {
                        result = await guestOrderAction('request_otp', client.sessionId, {
                            email: String(data.email || '')
                        }, client.catalogScope || null);
                    } catch (error) {
                        console.warn('[Guest orders] OTP request failed:', summarizeError(error));
                        result = {
                            status: 'error',
                            message: 'The verification code could not be requested. Please try again later.'
                        };
                    }
                    ws.send(JSON.stringify({ type: 'guest_order_otp_result', form_id: formId, purpose, result }));
                    break;
                }

                case 'guest_order_verify_otp': {
                    const purpose = data.purpose === 'support' ? 'support' : 'order';
                    if (client.customerId && purpose !== 'support') break;
                    const formId = String(data.form_id || '').slice(0, 120);
                    const email = String(data.email || '').trim();
                    let result;
                    try {
                        result = await guestOrderAction('verify_otp', client.sessionId, {
                            email,
                            code: String(data.code || '')
                        }, client.catalogScope || null);
                    } catch (error) {
                        console.warn('[Guest orders] OTP verification failed:', summarizeError(error));
                        result = {
                            status: 'error',
                            message: 'The verification code could not be checked. Please try again later.'
                        };
                    }
                    if (result?.status === 'success' && result.access_token) {
                        if (purpose === 'support') {
                            await rememberSupportEmailVerification(
                                client,
                                email,
                                String(result.access_token),
                                result.expires_at
                            );
                        } else {
                            const accessRemembered = await rememberGuestOrderAccess(
                                client,
                                email,
                                String(result.access_token),
                                Number(result.expires_in),
                                Number(result.expires_at)
                            );
                            if (accessRemembered) {
                                broadcastGuestSession(ws, client, guestOrderAccessState(client, 'verified'));
                            }
                        }
                    }
                    ws.send(JSON.stringify({
                        type: 'guest_order_verify_result',
                        form_id: formId,
                        purpose,
                        result: {
                            status: result?.status,
                            reason: result?.reason,
                            message: result?.message,
                            expires_at: purpose === 'support'
                                ? (hasActiveSupportEmailVerification(client)
                                    ? Math.floor(client.supportEmailVerifiedUntil / 1000)
                                    : null)
                                : (hasActiveGuestOrderAccess(client)
                                    ? Math.floor(client.guestOrderAccessExpiresAt / 1000)
                                    : null)
                        }
                    }));
                    if (result?.status === 'success' && purpose === 'support') {
                        consumePendingVerificationAction(client, purpose);
                        await sendSupportPortal(ws, client, formId);
                    } else if (result?.status === 'success') {
                        const pendingAction = consumePendingVerificationAction(client, purpose);
                        if (pendingAction && isSocketOpen(ws)) {
                            const resumeRequestId = `verification-resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                            ws.send(JSON.stringify({
                                type: 'verification_action_resuming',
                                request_id: resumeRequestId,
                                form_id: formId,
                                purpose,
                                content: purpose === 'support'
                                    ? 'Email verified. Creating your support request…'
                                    : 'Email verified. Continuing your request…'
                            }));
                            setImmediate(() => {
                                handleChat(ws, {
                                    action: 'chat',
                                    request_id: resumeRequestId,
                                    conversation_id: pendingAction.conversationId,
                                    text: pendingAction.text,
                                    parts: [{ text: pendingAction.text }],
                                    history: pendingAction.history,
                                    resume_pending_action: true
                                }, client).catch((error) => {
                                    console.error('[Verification] Could not resume pending action:', summarizeError(error));
                                    if (isSocketOpen(ws)) {
                                        ws.send(attachRequestId({
                                            type: 'error',
                                            content: 'Your email was verified, but the pending request could not continue. Please try again.'
                                        }, resumeRequestId));
                                    }
                                });
                            });
                        }
                    }
                    break;
                }

                case 'support_portal_load': {
                    await sendSupportPortal(ws, client, String(data.form_id || '').slice(0, 120));
                    break;
                }

                case 'support_ticket_create': {
                    const identity = supportPortalIdentity(client);
                    const formId = String(data.form_id || '').slice(0, 120);
                    if (!identity) {
                        ws.send(JSON.stringify({
                            type: 'support_ticket_create_result',
                            form_id: formId,
                            result: { status: 'requires_customer_action', reason: 'guest_access_required' }
                        }));
                        break;
                    }
                    let ticketResult;
                    try {
                        ticketResult = await createSupportCase(identity, data.source_conversation_id, {
                            category: data.category,
                            priority: 'normal',
                            subject: data.subject,
                            summary: data.message,
                            context: {}
                        }, client?.catalogScope || null);
                    } catch (error) {
                        console.warn('[Support] Ticket creation failed:', summarizeError(error));
                        ticketResult = { status: 'error', message: 'The support ticket could not be created.' };
                    }
                    ws.send(JSON.stringify({ type: 'support_ticket_create_result', form_id: formId, result: ticketResult }));
                    if (ticketResult?.status === 'success') {
                        await sendSupportPortal(ws, client, formId);
                        ws.send(JSON.stringify({ type: 'refresh_conversations' }));
                    }
                    break;
                }

                case 'order_address_update': {
                    const formId = String(data.form_id || '').slice(0, 160);
                    const addressArgs = normalizeOrderAddressArguments({
                        orderNumber: data.order_number || data.orderNumber,
                        addressType: data.address_type || data.addressType,
                        address: data.address
                    });
                    let result;
                    const admission = await addressUpdateAdmission.admit(client, data, {
                        resourceType: 'order',
                        orderNumber: addressArgs.orderNumber,
                        addressType: addressArgs.addressType
                    });

                    try {
                        if (admission.result) {
                            result = admission.result;
                        } else if (client.customerId) {
                            result = await executeCustomerOrderAction(
                                client.customerId,
                                'update_address',
                                addressArgs,
                                client.catalogScope || null
                            );
                        } else if (client.guestOrderAccessToken && client.guestOrderEmail) {
                            result = await guestOrderAction('update_address', client.sessionId, {
                                accessToken: client.guestOrderAccessToken,
                                email: client.guestOrderEmail,
                                ...addressArgs
                            }, client.catalogScope || null);
                            if (guestOrderAccessNeedsVerification(result)) {
                                await notifyGuestOrderAccessReset(ws, client);
                            }
                        } else {
                            result = {
                                status: 'requires_customer_action',
                                reason: 'guest_access_required',
                                message: 'Verify your email again before changing an order address.'
                            };
                            await notifyGuestOrderAccessReset(ws, client);
                        }
                    } catch (error) {
                        console.warn('[Orders] Address form update failed:', summarizeError(error));
                        result = {
                            status: 'error',
                            reason: 'address_update_failed',
                            message: 'The order address could not be updated. Please try again.'
                        };
                    } finally {
                        await admission.lock?.release();
                    }

                    ws.send(JSON.stringify({
                        type: 'order_address_update_result',
                        form_id: formId,
                        result: {
                            status: result?.status,
                            reason: result?.reason,
                            message: result?.message,
                            retry_after: result?.retry_after,
                            order_number: result?.order_number,
                            address_type: result?.address_type,
                            address: result?.address || null
                        }
                    }));
                    break;
                }

                case 'customer_address_update': {
                    const formId = String(data.form_id || '').slice(0, 160);
                    const addressArgs = normalizeCustomerAddressArguments({
                        addressType: data.address_type || data.addressType,
                        address: data.address
                    });
                    let result;
                    const admission = await addressUpdateAdmission.admit(client, data, {
                        resourceType: 'customer_account',
                        addressType: addressArgs.addressType
                    });

                    try {
                        result = admission.result || await executeCustomerAddressAction(
                            client.customerId || null,
                            'update',
                            {
                                ...addressArgs,
                                actionToken: String(data.action_token || data.actionToken || ''),
                                formId
                            },
                            client.catalogScope || null
                        );
                    } catch (error) {
                        console.warn('[Customer Addresses] Form update failed:', summarizeError(error));
                        result = {
                            status: 'error',
                            reason: 'address_update_failed',
                            message: 'Your account address could not be updated. Please try again.'
                        };
                    } finally {
                        await admission.lock?.release();
                    }

                    ws.send(JSON.stringify({
                        type: 'order_address_update_result',
                        form_id: formId,
                        result: {
                            status: result?.status,
                            reason: result?.reason,
                            message: result?.message,
                            retry_after: result?.retry_after,
                            address_type: result?.address_type,
                            address: result?.address || null
                        }
                    }));
                    break;
                }

                case 'new_chat': {
                    if (!client.customerId) {
                        broadcastGuestSession(ws, client, { type: 'guest_new_chat' });
                    }
                    break;
                }

                case 'reset_guest_history': {
                    if (client.customerId) break;
                    const mode = await guestHistoryMode(runtime, getAiConfig);
                    const cleared = mode === 'database'
                        ? await db.deleteGuestConversations(guestHistoryIdentity(client), client.catalogScope || null)
                        : await guestSessionHistory.clear(client.sessionId).then(() => true);
                    if (cleared) {
                        ws.send(JSON.stringify({ type: 'guest_history_reset' }));
                        broadcastGuestSession(ws, client, { type: 'guest_new_chat' });
                    } else {
                        ws.send(JSON.stringify({ type: 'error', content: 'Could not reset guest chat history.' }));
                    }
                    break;
                }

                case 'list_conversations': {
                    const requestedPage = Math.max(1, Number(data.page) || 1);
                    if (client.customerId) {
                        const conversationPage = await db.listConversations(client.customerId, requestedPage, client.catalogScope || null);
                        ws.send(JSON.stringify({
                            type: 'conversations',
                            conversations: conversationPage.conversations,
                            has_more: conversationPage.hasMore === true,
                            next_page: conversationPage.nextPage || null,
                            page: conversationPage.page || requestedPage,
                            append: data.append === true,
                            isLoggedIn: true,
                            historyAvailable: true
                        }));
                        return;
                    }
                    const mode = await guestHistoryMode(runtime, getAiConfig);
                    const conversationPage = mode === 'database'
                        ? await db.listGuestConversations(guestHistoryIdentity(client), requestedPage, client.catalogScope || null)
                        : await guestSessionHistory.list(client.sessionId, requestedPage);
                    ws.send(JSON.stringify({
                        type: 'conversations',
                        conversations: conversationPage.conversations,
                        has_more: conversationPage.hasMore === true,
                        next_page: conversationPage.nextPage || null,
                        page: conversationPage.page || requestedPage,
                        append: data.append === true,
                        isLoggedIn: false,
                        historyAvailable: true
                    }));
                    break;
                }

                case 'load_conversation': {
                    if (!data.conversation_id) {
                        ws.send(JSON.stringify({ type: 'conversation_messages', messages: [], status: 'error', conversationId: 0, client_load_token: String(data.client_load_token || '') }));
                        return;
                    }
                    let mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig);
                    let conv = mode === 'customer'
                        ? await db.getConversation(data.conversation_id, client.customerId, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.getGuestConversation(data.conversation_id, guestHistoryIdentity(client), client.catalogScope || null)
                            : await guestSessionHistory.get(client.sessionId, data.conversation_id));
                    console.log('[AI-SERVER] load_conversation:', { conversation_id: data.conversation_id, customerId: client.customerId, guestId: guestHistoryIdentity(client), mode, found: Boolean(conv) });
                    if (!conv) {
                        ws.send(JSON.stringify({ type: 'conversation_messages', messages: [], status: 'error', conversationId: Number(data.conversation_id) || 0, client_load_token: String(data.client_load_token || '') }));
                        return;
                    }
                    const page = mode === 'customer'
                        ? await db.loadMessages(data.conversation_id, client.customerId, data.before_message_id || null, client.catalogScope || null)
                        : (mode === 'database'
                        ? await db.loadGuestMessages(data.conversation_id, guestHistoryIdentity(client), data.before_message_id || null, client.catalogScope || null)
                            : await guestSessionHistory.loadMessages(client.sessionId, data.conversation_id, data.before_message_id || null));
                    const messages = await prepareHistoryMessages(
                        page.messages || [],
                        client,
                        data.conversation_id
                    );
                    console.log('[AI-SERVER] sending conversation_messages:', { conversation_id: data.conversation_id, count: messages.length });
                    ws.send(JSON.stringify({
                        type: 'conversation_messages',
                        status: 'success',
                        messages,
                        has_more: page.has_more === true,
                        next_before_message_id: page.next_before_message_id || null,
                        append: Boolean(data.before_message_id),
                        refresh: data.refresh === true,
                        conversationId: data.conversation_id,
                        client_load_token: String(data.client_load_token || ''),
                        title: conv.title
                    }));
                    if (!data.before_message_id) {
                        const supportState = await supportConversationState(client, data.conversation_id);
                        client.activeSupportConversationId = supportState.isSupport && !supportState.closed
                            ? Number(data.conversation_id)
                            : 0;
                        ws.send(JSON.stringify({
                            type: 'support_mode',
                            conversation_id: Number(data.conversation_id),
                            active: supportState.active,
                            closed: supportState.closed,
                            status: supportState.status,
                            agent_label: supportState.agentLabel
                        }));
                    }
                    break;
                }

                case 'delete_conversation': {
                    if (!data.conversation_id) {
                        ws.send(JSON.stringify({ type: 'delete_result', status: 'error', conversation_id: 0, message: 'Conversation is required.' }));
                        return;
                    }
                    const conversationId = Number(data.conversation_id) || 0;
                    const mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig);
                    const deleted = mode === 'customer'
                        ? await db.deleteConversation(conversationId, client.customerId, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.deleteGuestConversation(conversationId, guestHistoryIdentity(client), client.catalogScope || null)
                            : await guestSessionHistory.delete(client.sessionId, conversationId));
                    ws.send(JSON.stringify({
                        type: 'delete_result',
                        status: deleted ? 'success' : 'error',
                        conversation_id: conversationId,
                        message: deleted ? '' : 'The conversation could not be deleted.'
                    }));
                    break;
                }

                case 'rename_conversation': {
                    if (!data.conversation_id) {
                        ws.send(JSON.stringify({ type: 'rename_result', status: 'error', message: 'Conversation is required' }));
                        return;
                    }

                    const title = String(data.title || '').trim().slice(0, 255);
                    if (!title) {
                        ws.send(JSON.stringify({ type: 'rename_result', status: 'error', message: 'Title is required' }));
                        return;
                    }

                    const mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig);
                    const updated = mode === 'customer'
                        ? await db.updateConversationTitle(data.conversation_id, client.customerId, title, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.updateGuestConversationTitle(data.conversation_id, guestHistoryIdentity(client), title, client.catalogScope || null)
                            : await guestSessionHistory.rename(client.sessionId, data.conversation_id, title));
                    ws.send(JSON.stringify({
                        type: 'rename_result',
                        status: updated ? 'success' : 'error',
                        conversation_id: data.conversation_id,
                        title
                    }));
                    if (updated) {
                        ws.send(JSON.stringify({ type: 'refresh_conversations' }));
                    }
                    break;
                }

                default:
                    ws.send(JSON.stringify({ type: 'error', content: 'Unknown action' }));
            }
        } catch (error) {
            console.error('Message handling error:', summarizeError(error));
            ws.send(JSON.stringify({ type: 'error', content: 'Internal server error' }));
        }
    });
    ws.on('close', () => {
        connectionLifecycle.handleClose(ws);
    });
    ws.on('error', (err) => {
        connectionLifecycle.handleError(ws, err);
    });
});

// ==================== CHAT HANDLER ====================

async function handleProductPage(ws, data, client) {
    const productPartId = String(data.product_part_id || '').trim().slice(0, 120);
    const context = verifyCatalogPageToken(data.continuation);

    if (!productPartId || !context) {
        ws.send(JSON.stringify({
            type: 'product_page_error',
            product_part_id: productPartId,
            content: 'This product list has expired. Ask the assistant to search again.'
        }));
        return;
    }

    const aiConfig = await getAiConfig(runtime, client.catalogScope?.storeCode || '');
    const rateLimit = await runtime.consumeRateLimit(`${client.rateLimitKey}:catalog-page`, {
        limit: aiConfig.rate_limits?.product_pages_per_minute || MAX_PRODUCT_PAGE_REQUESTS_PER_MINUTE,
        windowMs: 60 * 1000
    });
    if (!rateLimit.allowed) {
        ws.send(JSON.stringify({
            type: 'product_page_error',
            product_part_id: productPartId,
            content: `Please wait ${Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))} seconds before loading more products.`
        }));
        return;
    }

    try {
        if (!aiConfig.enabled) {
            throw new Error('The AI service is disabled.');
        }

        const { content, params } = await loadCatalogPage({
            ...context,
            catalogScope: client.catalogScope || null,
            pageContext: client.pageContext || null,
            customerId: client.customerId || 0
        }, aiConfig, runtime);
        if (content?.error) {
            throw new Error('The next product page could not be retrieved.');
        }

        const presentation = buildCatalogProductsPayload(content, params);
        ws.send(JSON.stringify({
            type: 'products_page',
            product_part_id: productPartId,
            html: String(content?.html || ''),
            products: presentation.payload
        }));
        metrics.increment('catalog_page_loaded');
    } catch (error) {
        console.warn('[Catalog pagination] Could not load the next page:', summarizeError(error));
        ws.send(JSON.stringify({
            type: 'product_page_error',
            product_part_id: productPartId,
            content: 'Could not load more products. Please try again.'
        }));
    }
}

async function handleChat(ws, data, client, requestConfig = null) {
    const { history = [], conversation_id } = data;
    const aiConfig = requestConfig || await getAiConfig(runtime, client.catalogScope?.storeCode || '');
    const isResumedAction = data.resume_pending_action === true;
    const replaceFromMessageId = Math.max(0, Math.floor(Number(data.replace_from_message_id) || 0));
    const currentUser = buildUserMessageDescriptor(data, {
        imageDisplayText: 'Sent an image'
    });
    const run = createActiveRun(ws, data.request_id || null);

    const imageValidationError = validateImageParts(currentUser.parts, {
        maxBytes: aiConfig.attachments?.max_image_bytes || MAX_IMAGE_BYTES,
        maxCount: aiConfig.attachments?.max_images_per_message || MAX_IMAGES_PER_MESSAGE,
        maxTotalBytes: aiConfig.attachments?.max_total_image_bytes,
        maxEncodedBytes: Math.min(
            aiConfig.attachments?.max_total_encoded_bytes || MAX_WS_ENCODED_IMAGE_BYTES,
            MAX_WS_ENCODED_IMAGE_BYTES
        )
    });
    if (imageValidationError) {
        ws.send(attachRequestId({ type: 'error', content: imageValidationError }, run.requestId));
        clearActiveRun(ws, run);
        return;
    }

    const imageAdmission = await admitImageRequest(
        runtime,
        client,
        currentUser.parts,
        aiConfig.attachments || {}
    );
    if (!imageAdmission.allowed) {
        metrics.increment('image_upload_rejected', { reason: 'rate_limited' });
        ws.send(attachRequestId({
            type: 'busy',
            error_code: 'VISION_RATE_LIMITED',
            recoverable: true,
            retry_after: Math.max(1, Math.ceil((imageAdmission.retryAfterMs || 1000) / 1000)),
            content: 'Image requests are temporarily limited. Please wait a moment.'
        }, run.requestId));
        clearActiveRun(ws, run);
        return;
    }
    if (imageAdmission.cost.imageCount > 0) {
        metrics.observeBytes('image_input', imageAdmission.cost.binaryBytes);
    }

    if (!currentUser.text || !currentUser.text.trim()) {
        ws.send(attachRequestId({ type: 'error', content: 'Empty message' }, run.requestId));
        clearActiveRun(ws, run);
        return;
    }

    let conversationId = conversation_id ? Number(conversation_id) : null;
    const catalogScope = client.catalogScope || null;
    const requestedSupportState = conversation_id
        ? await supportConversationState(client, Number(conversation_id))
        : null;
    const guestMode = client.customerId
        ? null
        : (requestedSupportState?.isSupport || aiConfig.persist_guest_history === true ? 'database' : 'session');
    let savedUserMessageId = 0;

    if (requestedSupportState?.closed) {
        ws.send(attachRequestId({
            type: 'support_mode',
            conversation_id: Number(conversation_id),
            active: false,
            closed: true,
            status: requestedSupportState.status || 'closed',
            agent_label: ''
        }, run.requestId));
        ws.send(attachRequestId({ type: 'done' }, run.requestId));
        clearActiveRun(ws, run);
        return;
    }

    // For logged-in users: manage conversations
    if (client.customerId) {
        try {
            console.log(`[Chat] Handling authenticated message [conversation=${conversationId ? 'existing' : 'new'}]`);
            // Verify ownership if conversation_id provided
            if (conversationId) {
                const conv = await db.getConversation(conversationId, client.customerId, catalogScope);
                if (!conv) {
                    if (isResumedAction) {
                        ws.send(attachRequestId({ type: 'error', content: 'The verified request has expired. Please try again.' }, run.requestId));
                        clearActiveRun(ws, run);
                        return;
                    }
                    if (replaceFromMessageId > 0) {
                        ws.send(attachRequestId({
                            type: 'error',
                            content: 'This message can no longer be replaced. Reload the conversation and try again.'
                        }, run.requestId));
                        clearActiveRun(ws, run);
                        return;
                    }
                    console.warn('[Chat] Requested conversation is unavailable; creating a new conversation.');
                    conversationId = null; // Will create new
                }
            }

            if (replaceFromMessageId > 0 && !conversationId) {
                ws.send(attachRequestId({
                    type: 'error',
                    content: 'This message can no longer be replaced. Reload the conversation and try again.'
                }, run.requestId));
                clearActiveRun(ws, run);
                return;
            }

            // Create new conversation if needed
            if (!conversationId) {
                const title = buildConversationTitle(currentUser.displayText || currentUser.text || '', {
                    hasImage: currentUser.hasImage
                });
                conversationId = await db.createConversation(client.customerId, title, catalogScope);
                console.log('[Chat] Created conversation.');
                ws.send(attachRequestId({ type: 'conversation_id', conversation_id: conversationId }, run.requestId));
            }

            if (!isResumedAction && replaceFromMessageId > 0) {
                const truncated = await db.truncateConversationFromMessage(
                    conversationId,
                    client.customerId,
                    replaceFromMessageId,
                    catalogScope
                );
                if (!truncated) {
                    ws.send(attachRequestId({
                        type: 'error',
                        content: 'This message can no longer be replaced. Reload the conversation and try again.'
                    }, run.requestId));
                    clearActiveRun(ws, run);
                    return;
                }
            }

            // Save user message
            try {
                if (isResumedAction) {
                    // The original user message was persisted before OTP. A
                    // resumed action must execute it, not create a duplicate.
                    await db.touchConversation(conversationId, client.customerId, catalogScope);
                } else {
                    const userMessageContent = currentUser.displayText || currentUser.text || '';
                    const uploadedImages = Array.isArray(data.images) ? data.images : [];
                    const imageParts = currentUser.parts
                        .filter((part) => part && part.inline_data)
                        .map((part) => part.inline_data);
                    const attachment = imageParts.length > 0 ? JSON.stringify({
                        attachments: imageParts.map((imagePart, index) => ({
                            name: String(uploadedImages[index]?.name || data.image?.name || 'uploaded-image').slice(0, 120),
                            mime_type: imagePart.mime_type,
                            data: imagePart.data
                        }))
                    }) : null;
                    savedUserMessageId = await db.saveMessage(
                        conversationId,
                        client.customerId,
                        'user',
                        userMessageContent,
                        attachment,
                        catalogScope
                    );
                    console.log('[Chat] Saved user message.');
                    ws.send(attachRequestId({
                        type: 'message_saved',
                        role: 'user',
                        entity_id: savedUserMessageId
                    }, run.requestId));
                    await db.touchConversation(conversationId, client.customerId, catalogScope);
                }
            } catch (err) {
                console.error('[Chat] Failed to save user message:', err.message);
            }
        } catch (error) {
            console.error('[Chat] Conversation setup failed:', summarizeError(error));
            ws.send(attachRequestId({ type: 'error', content: 'Could not start this conversation. Please try again in a moment.' }, run.requestId));
            clearActiveRun(ws, run);
            return;
        }
    } else {
        try {
            const requestedConversation = conversationId
                ? (guestMode === 'database'
                    ? await db.getGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope)
                    : await guestSessionHistory.get(client.sessionId, conversationId))
                : null;
            const page = requestedConversation ? null : (guestMode === 'database'
                ? await db.listGuestConversations(guestHistoryIdentity(client), 1, catalogScope)
                : await guestSessionHistory.list(client.sessionId, 1));
            const existing = requestedConversation || page?.conversations?.[0] || null;
            if (existing) {
                conversationId = Number(existing.id);
            } else if (replaceFromMessageId > 0) {
                ws.send(attachRequestId({
                    type: 'error',
                    content: 'This message can no longer be replaced. Reload the conversation and try again.'
                }, run.requestId));
                clearActiveRun(ws, run);
                return;
            } else {
                const title = buildConversationTitle(currentUser.displayText || currentUser.text || '', {
                    hasImage: currentUser.hasImage
                });
                const conversation = guestMode === 'database'
                    ? { id: await db.createGuestConversation(guestHistoryIdentity(client), title, catalogScope) }
                    : await guestSessionHistory.create(client.sessionId, title);
                conversationId = Number(conversation.id || conversation);
                if (guestMode === 'session') {
                    await restoreGuestHistoryFromClient(history, client.sessionId, conversationId);
                }
                ws.send(attachRequestId({ type: 'conversation_id', conversation_id: conversationId }, run.requestId));
            }

            if (!isResumedAction && replaceFromMessageId > 0) {
                const truncated = guestMode === 'database'
                    ? await db.truncateGuestConversationFromMessage(
                        conversationId,
                        guestHistoryIdentity(client),
                        replaceFromMessageId,
                        catalogScope
                    )
                    : await guestSessionHistory.truncateFromMessage(
                        client.sessionId,
                        conversationId,
                        replaceFromMessageId
                    );
                if (!truncated) {
                    ws.send(attachRequestId({
                        type: 'error',
                        content: 'This message can no longer be replaced. Reload the conversation and try again.'
                    }, run.requestId));
                    clearActiveRun(ws, run);
                    return;
                }
            }

            if (isResumedAction) {
                if (guestMode === 'database') {
                    await db.touchGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope);
                }
            } else if (guestMode === 'database') {
                const uploadedImages = Array.isArray(data.images) ? data.images : [];
                const imageParts = currentUser.parts.filter((part) => part?.inline_data).map((part) => part.inline_data);
                const attachment = imageParts.length > 0 ? JSON.stringify({
                    attachments: imageParts.map((imagePart, index) => ({
                        name: String(uploadedImages[index]?.name || data.image?.name || 'uploaded-image').slice(0, 120),
                        mime_type: imagePart.mime_type,
                        data: imagePart.data
                    }))
                }) : null;
                savedUserMessageId = await db.saveGuestMessage(
                    conversationId,
                    guestHistoryIdentity(client),
                    'user',
                    currentUser.displayText || currentUser.text || '',
                    attachment,
                    catalogScope
                );
                ws.send(attachRequestId({
                    type: 'message_saved',
                    role: 'user',
                    entity_id: savedUserMessageId
                }, run.requestId));
                await db.touchGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope);
            } else {
                savedUserMessageId = await guestSessionHistory.append(
                    client.sessionId,
                    conversationId,
                    guestUserHistoryMessage(currentUser, data)
                );
                ws.send(attachRequestId({
                    type: 'message_saved',
                    role: 'user',
                    entity_id: savedUserMessageId
                }, run.requestId));
            }
            await broadcastGuestConversation(ws, client, guestMode, conversationId);
        } catch (error) {
            console.error('[Chat] Guest conversation setup failed:', summarizeError(error));
            ws.send(attachRequestId({ type: 'error', content: 'Could not start this conversation. Please try again in a moment.' }, run.requestId));
            clearActiveRun(ws, run);
            return;
        }
    }

    let admission = null;
    let leaseHeartbeat = null;
    const processingStartedAt = Date.now();
    const assistantParts = [];
    let interruptedResponsePersistence = null;

    const persistAssistantResponse = async (parts, metadata = {}, options = {}) => {
        const assistantPayload = buildAssistantStoragePayload(parts, metadata);
        if (!assistantPayload || !conversationId) {
            return false;
        }

        let savedMessageId = null;
        let persistent = false;
        if (client.customerId) {
            savedMessageId = await db.saveMessage(conversationId, client.customerId, 'assistant', assistantPayload, null, catalogScope);
            persistent = true;
            await db.touchConversation(conversationId, client.customerId, catalogScope);

            if (options.refreshTitle === true && !conversation_id) {
                const newTitle = buildConversationTitle(currentUser.displayText || currentUser.text || '', {
                    hasImage: currentUser.hasImage
                });
                await db.updateConversationTitle(conversationId, client.customerId, newTitle, catalogScope);
                ws.send(JSON.stringify({ type: 'refresh_conversations' }));
            }
            ws.send(attachRequestId({ type: 'message_saved', role: 'assistant', entity_id: savedMessageId, persistent }, run.requestId));
            void reportAssistantCompletion({
                config: aiConfig,
                client: { ...client, guestId: guestHistoryIdentity(client) },
                conversationId,
                messageId: savedMessageId,
                parts,
                durationMs: Date.now() - processingStartedAt
            });
            return true;
        }

        if (guestMode === 'database') {
            savedMessageId = await db.saveGuestMessage(conversationId, guestHistoryIdentity(client), 'assistant', assistantPayload, null, catalogScope);
            persistent = true;
            await db.touchGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope);
        } else {
            savedMessageId = await guestSessionHistory.append(
                client.sessionId,
                conversationId,
                guestAssistantHistoryMessage(parts, metadata)
            );
        }

        ws.send(attachRequestId({ type: 'message_saved', role: 'assistant', entity_id: savedMessageId, persistent }, run.requestId));
        void reportAssistantCompletion({
            config: aiConfig,
            client: { ...client, guestId: guestHistoryIdentity(client) },
            conversationId,
            messageId: savedMessageId,
            parts,
            durationMs: Date.now() - processingStartedAt
        });
        await broadcastGuestConversation(ws, client, guestMode, conversationId);
        ws.send(JSON.stringify({ type: 'refresh_conversations' }));
        return true;
    };

    const persistInterruptedAssistantResponse = () => {
        if (interruptedResponsePersistence) {
            return interruptedResponsePersistence;
        }

        const interruptedResponse = buildInterruptedAssistantPayload(assistantParts, run.startedAt);
        if (interruptedResponse.parts.length === 0) {
            return Promise.resolve(false);
        }

        interruptedResponsePersistence = persistAssistantResponse(
            interruptedResponse.parts,
            interruptedResponse
        );
        return interruptedResponsePersistence;
    };

    try {
        if (isRunCancelled(run)) {
            notifyCancelled(ws, run);
            return;
        }

        if (!client.customerId) {
            await hydrateGuestOrderAccess(client);
        }

        const supportState = requestedSupportState?.isSupport
            ? requestedSupportState
            : await supportConversationState(client, conversationId);
        client.activeSupportConversationId = supportState.isSupport && !supportState.closed
            ? Number(conversationId)
            : 0;
        ws.send(attachRequestId({
            type: 'support_mode',
            conversation_id: conversationId,
            active: supportState.active,
            closed: supportState.closed,
            status: supportState.status,
            agent_label: supportState.agentLabel
        }, run.requestId));
        if (supportState.active) {
            if (savedUserMessageId > 0) {
                broadcastSupportMessageToAdmins({
                    conversationId,
                    messageId: savedUserMessageId
                });
            }
            broadcastSupportTypingToAdmins({ conversationId, typing: false });
            ws.send(attachRequestId({ type: 'done' }, run.requestId));
            metrics.increment('support_live_message_received');
            return;
        }

        // The configuration snapshot is loaded before the conversation so the
        // selected guest-history mode remains consistent for this request.
        if (!aiConfig.enabled) {
            ws.send(attachRequestId({ type: 'error', content: 'The AI service is disabled.' }, run.requestId));
            return;
        }

        const totalConcurrency = aiConfig.capacity?.concurrent_model_requests || MAX_CONCURRENT_MODEL_REQUESTS;
        const visionConcurrency = Math.min(
            Math.max(1, aiConfig.attachments?.vision_concurrency || 4),
            Math.max(1, totalConcurrency - 1),
            Math.max(1, Math.floor(totalConcurrency / 2))
        );
        const capacityNamespace = totalConcurrency > 1
            ? (currentUser.hasImage ? 'vision' : 'text')
            : 'model';
        const requestConcurrency = totalConcurrency > 1
            ? (currentUser.hasImage ? visionConcurrency : totalConcurrency - visionConcurrency)
            : 1;
        admission = await runtime.acquireCapacity(run.requestId, {
            namespace: capacityNamespace,
            concurrency: requestConcurrency,
            maxQueue: aiConfig.capacity?.queue_depth ?? MAX_QUEUE_DEPTH,
            queueWaitMs: aiConfig.capacity?.queue_wait_ms || MAX_QUEUE_WAIT_MS,
            leaseMs: aiConfig.capacity?.model_lease_ms || MODEL_LEASE_MS,
            signal: run.controller.signal
        });
        metrics.observe('queue_wait', admission.queueWaitMs / 1000);
        metrics.increment('model_admitted', { provider: aiConfig.provider });
        leaseHeartbeat = setInterval(() => {
            admission.renew().catch(() => {
                run.controller.abort();
            });
        }, Math.max(1000, Math.floor((aiConfig.capacity?.model_lease_ms || MODEL_LEASE_MS) / 3)));
        const streamChatResponse = await getOrchestrator(aiConfig.provider);

        // Collect the customer-visible streamed response for persistence.
        const wrappedWs = {
            send: (msgStr) => {
                if (!isRunCancelled(run) && isSocketOpen(ws)) {
                    let outbound = attachRequestId(msgStr, run.requestId);
                    try {
                        const parsed = JSON.parse(outbound);
                        if (parsed.type === 'guest_order_access_required') {
                            parsed.expires_at = Number(parsed.expires_at) > Date.now()
                                ? Number(parsed.expires_at)
                                : Date.now() + CUSTOMER_ACTION_FORM_TTL_MS;
                            outbound = JSON.stringify(parsed);
                            rememberPendingVerificationAction(client, {
                                purpose: parsed.purpose === 'support' ? 'support' : 'order',
                                conversationId,
                                text: currentUser.text,
                                history
                            }, { ttlMs: PENDING_VERIFICATION_ACTION_TTL_MS });
                            if (parsed.purpose === 'support') {
                                clearSupportEmailVerification(client).catch((error) => {
                                    console.warn('[Support] Could not clear expired email access:', summarizeError(error));
                                });
                            } else {
                                // Magento rejected or expired the short-lived
                                // order token. Remove only the order cache.
                                client.guestOrderEmail = '';
                                client.guestOrderAccessToken = '';
                                client.guestOrderAccessExpiresAt = 0;
                                runtime.deleteAuthCache(guestOrderAccessCacheKey(client.sessionId)).catch((error) => {
                                    console.warn('[Guest orders] Could not clear expired order access:', summarizeError(error));
                                });
                                const accessState = attachRequestId(guestOrderAccessState(client, 'email'), run.requestId);
                                ws.send(accessState);
                                broadcastGuestSession(ws, client, guestOrderAccessState(client, 'email'));
                            }
                        }
                        ws.send(outbound);
                        recordOutboundAssistantPart(assistantParts, parsed);
                        if (parsed.type === 'order_address_form') {
                            const addressForm = normalizeOrderAddressFormPart(parsed);
                            if (addressForm) {
                                addressUpdateAdmission.activate(client, conversationId, addressForm).catch((error) => {
                                    console.warn('[Address form] Could not activate form:', summarizeError(error));
                                });
                            }
                        }
                    } catch (e) {
                        ws.send(outbound);
                    }
                }
            }
        };

        // Run AI stream
        const streamResult = await streamChatResponse(
            currentUser,
            wrappedWs,
            trimHistoryForModel(
                history,
                aiConfig.agent?.max_model_history_messages,
                aiConfig.agent?.max_history_tokens,
                (stats) => {
                    metrics.observeBytes('history_context_raw', stats.rawBytes, { provider: aiConfig.provider });
                    metrics.observeBytes('history_context_model', stats.modelBytes, { provider: aiConfig.provider });
                }
            ),
            client.token,
            aiConfig,
            {
            signal: run.controller.signal,
            isCancelled: () => isRunCancelled(run),
            runtime,
            customerId: client.customerId || null,
            guestId: client.customerId ? null : guestHistoryIdentity(client),
            rateLimitIdentity: client.rateLimitKey,
            guestOrderAccess: hasActiveGuestOrderAccess(client)
                ? {
                    token: client.guestOrderAccessToken,
                    email: client.guestOrderEmail,
                    sessionId: client.sessionId,
                    expiresAt: client.guestOrderAccessExpiresAt
                }
                : null,
            supportEmailAccess: hasActiveSupportEmailVerification(client)
                ? {
                    email: client.supportEmail,
                    token: client.supportEmailAccessToken,
                    sessionId: client.sessionId,
                    expiresAt: client.supportEmailVerifiedUntil
                }
                : null,
            requestOrderAddressForm: isOrderAddressChangeRequest(currentUser.text),
            requestCustomerAddressForm: isCustomerAddressChangeRequest(currentUser.text),
            conversationId,
            catalogScope: client.catalogScope || null,
            sessionCookie: client.sessionCookie || '',
            requestBrowserCart: (cart) => browserCartBridge.request(ws, {
                requestId: run.requestId,
                cart,
                conversationId,
                signal: run.controller.signal
            }),
            onContextReduction: (stats) => {
                metrics.increment('tool_context_reduced', {
                    tool: stats.toolName,
                    strategy: stats.strategy
                });
                metrics.observeBytes('tool_context_raw', stats.rawBytes, { tool: stats.toolName });
                metrics.observeBytes('tool_context_model', stats.modelBytes, { tool: stats.toolName });
            },
            onGuardrailDecision: (decision) => {
                metrics.increment('guardrail_decision', {
                    tool: String(decision?.toolName || '').slice(0, 80),
                    decision: decision?.allowed === true ? 'allowed' : 'blocked',
                    reason: String(decision?.reason || 'unknown').slice(0, 80)
                });
                void reportGuardrailDecision({
                    config: aiConfig,
                    client: { ...client, guestId: guestHistoryIdentity(client) },
                    conversationId,
                    decision
                });
            }
        });

        if (isRunCancelled(run) || streamResult?.cancelled) {
            await persistInterruptedAssistantResponse().catch((error) => {
                console.warn('[Chat] Could not persist interrupted response:', summarizeError(error));
            });
            notifyCancelled(ws, run);
            return;
        }

        await persistAssistantResponse(assistantParts, {}, { refreshTitle: true });

        metrics.increment('model_completed', { provider: aiConfig.provider });

    } catch (error) {
        if (isRunCancelled(run) || isAbortError(error)) {
            await persistInterruptedAssistantResponse().catch((persistenceError) => {
                console.warn('[Chat] Could not persist interrupted response:', summarizeError(persistenceError));
            });
            notifyCancelled(ws, run);
            return;
        }
        if (['QUEUE_FULL', 'QUEUE_TIMEOUT', 'QUEUE_EXPIRED'].includes(error.code)) {
            metrics.increment('model_busy', { reason: error.code });
            ws.send(attachRequestId({
                type: 'busy',
                error_code: 'SERVICE_BUSY',
                recoverable: true,
                retry_after: Math.max(1, Math.ceil((error.retryAfterMs || 1000) / 1000)),
                content: 'The AI service is busy. Please try again shortly.'
            }, run.requestId));
            return;
        }
        metrics.increment('model_failed', { reason: error.code || 'unknown' });
        console.error('Chat handler error:', summarizeError(error));
        ws.send(attachRequestId({
            type: 'error',
            content: 'The AI service could not complete this request. Please try again.'
        }, run.requestId));
    } finally {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        if (admission) await admission.release().catch(() => {});
        metrics.observe('chat_duration', (Date.now() - processingStartedAt) / 1000);
        clearActiveRun(ws, run);
    }
}

// ==================== START ====================

async function startGateway() {
    await runtime.connect();
    addConfiguredWebSocketOrigins(allowedWebSocketOrigins, await getAiConfigSnapshot(runtime));
    server.listen(port, () => {
        console.log(`AI Gateway replica ${runtime.instanceId} listening at http://localhost:${port} [WebSocket + REST]`);
        console.log(`Shared Redis state: ${runtime.mode}; model concurrency cap: ${MAX_CONCURRENT_MODEL_REQUESTS}; queue cap: ${MAX_QUEUE_DEPTH}`);
    });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        stopGateway({ server, wss, runtime }).finally(() => process.exit(0));
    });
}

startGateway().catch((error) => {
    console.error('Afd AI Gateway could not start:', summarizeError(error));
    process.exit(1);
});
