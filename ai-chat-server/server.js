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
import {
    hasActiveGuestOrderAccess,
    hasActiveSupportEmailVerification,
    guestOrderAccessState,
    guestOrderAccessNeedsVerification
} from './services/security/guest-access.js';

// Services
import { getAiConfig, getAiConfigSnapshot } from './services/configuration/config-service.js';
import { getOrchestrator, getProviderCircuitHealth } from './services/orchestration/orchestrator-factory.js';
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
import { normalizeProviderResponseMetadata } from './services/orchestration/provider-response-envelope.js';
import { createVerifiedAccessSession } from './services/customer/verified-access-session.js';
import { createGuestHistorySync } from './services/conversation/guest-history-sync.js';
import { createMessageHandlers } from './services/gateway/message-handlers.js';
import { logger } from './services/logger.js';
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
const {
    broadcastGuestConversation,
    broadcastGuestSession,
    buildUserMessageAttachmentPayload,
    guestAssistantHistoryMessage,
    guestUserHistoryMessage,
    restoreGuestHistoryFromClient
} = createGuestHistorySync({
    wss,
    clientData,
    isSocketOpen,
    guestSessionHistory,
    loadGuestMessages: db.loadGuestMessages,
    getPrepareHistoryMessages: () => prepareHistoryMessages,
    extractTextFromParts,
    guestHistoryMessagesFromClient,
    summarizeError
});
const {
    clearGuestOrderAccess,
    clearSupportEmailVerification,
    hydrateGuestOrderAccess,
    hydrateSupportEmailVerification,
    notifyGuestOrderAccessReset,
    rememberGuestOrderAccess,
    rememberSupportEmailVerification,
    sendSupportPortal,
    supportConversationState,
    supportPortalIdentity
} = createVerifiedAccessSession({
    runtime,
    getSupportConversationState,
    listSupportCases,
    summarizeError,
    broadcastGuestSession,
    isSocketOpen
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
    providerHealth: getProviderCircuitHealth,
    revokeSession: ({ sessionHash, customerId }) => revokeCustomerSockets({
        clientData,
        sessionHash,
        customerId,
        isSocketOpen,
        cancelActiveRun,
        rejectBrowserCart: (socket) => browserCartBridge.rejectAll(socket)
    })
});

const browserCartBridge = new BrowserCartBridge({ isSocketOpen });

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

// Chat and catalog pagination handling live in message-handlers.js. The
// dependency object below is the complete boundary: the handlers receive the
// same composed services the connection layer uses and own no global state.
const {
    handleProductPage,
    handleChat
} = createMessageHandlers({
    runtime,
    metrics,
    guestSessionHistory,
    isSocketOpen,
    browserCartBridge,
    addressUpdateAdmission,
    supportConversationState,
    hydrateGuestOrderAccess,
    clearSupportEmailVerification,
    clearGuestOrderAccess,
    broadcastGuestSession,
    broadcastGuestConversation,
    broadcastSupportMessageToAdmins,
    broadcastSupportTypingToAdmins,
    buildAssistantStoragePayload,
    buildConversationTitle,
    buildUserMessageAttachmentPayload,
    guestUserHistoryMessage,
    guestAssistantHistoryMessage,
    restoreGuestHistoryFromClient,
    trimHistoryForModel,
    createActiveRun,
    clearActiveRun,
    isRunCancelled,
    notifyCancelled,
    maxProductPageRequestsPerMinute: MAX_PRODUCT_PAGE_REQUESTS_PER_MINUTE,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
    maxWebSocketEncodedImageBytes: MAX_WS_ENCODED_IMAGE_BYTES,
    maxConcurrentModelRequests: MAX_CONCURRENT_MODEL_REQUESTS,
    maxQueueDepth: MAX_QUEUE_DEPTH,
    maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
    modelLeaseMs: MODEL_LEASE_MS,
    pendingVerificationActionTtlMs: PENDING_VERIFICATION_ACTION_TTL_MS,
    customerActionFormTtlMs: CUSTOMER_ACTION_FORM_TTL_MS
});

wss.on('connection', async (ws, req) => {
    try {
        // Configurations are shared through Redis. Refresh the configured
        // origins at each connection so a newly synchronized Magento tenant
        // is accepted by every replica without a Node restart.
        addConfiguredWebSocketOrigins(allowedWebSocketOrigins, await getAiConfigSnapshot(runtime));
    } catch {
        metrics.increment('websocket_rejected', { reason: 'config_unavailable' });
        ws.close(1013, 'Gateway configuration is temporarily unavailable');
        return;
    }
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
    const tenantId = auth.tenantId || auth.catalogScope?.tenantId || '';
    const tenantPrefix = tenantId ? `tenant:${tenantId}:` : '';

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
        tenantId,
        pageContext: auth.pageContext || null,
        // Stable across reconnects so a new short-lived connection ticket
        // cannot reset chat or mutation throttles.
        rateLimitKey: customerId ? `${tenantPrefix}customer:${customerId}` : `${tenantPrefix}session:${auth.sessionId}`,
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
    logger.info('gateway', `Client connected [auth=${auth.source || 'guest'}, total=${wss.clients.size}]`);

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
                    const aiConfig = await getAiConfig(runtime, client.catalogScope?.storeCode || '', client.tenantId || client.catalogScope?.tenantId || '');
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
                    const mode = await guestHistoryMode(runtime, getAiConfig, client);
                    const cleared = mode === 'database'
                        ? await db.deleteGuestConversations(guestHistoryIdentity(client), client.catalogScope || null)
                        : await guestSessionHistory.clear(guestHistoryIdentity(client)).then(() => true);
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
                    const mode = await guestHistoryMode(runtime, getAiConfig, client);
                    const conversationPage = mode === 'database'
                        ? await db.listGuestConversations(guestHistoryIdentity(client), requestedPage, client.catalogScope || null)
                        : await guestSessionHistory.list(guestHistoryIdentity(client), requestedPage);
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
                    let mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig, client);
                    let conv = mode === 'customer'
                        ? await db.getConversation(data.conversation_id, client.customerId, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.getGuestConversation(data.conversation_id, guestHistoryIdentity(client), client.catalogScope || null)
                            : await guestSessionHistory.get(guestHistoryIdentity(client), data.conversation_id));
                    logger.debug('conversation', 'load_conversation:', { conversation_id: data.conversation_id, customerId: client.customerId, guestId: guestHistoryIdentity(client), mode, found: Boolean(conv) });
                    if (!conv) {
                        ws.send(JSON.stringify({ type: 'conversation_messages', messages: [], status: 'error', conversationId: Number(data.conversation_id) || 0, client_load_token: String(data.client_load_token || '') }));
                        return;
                    }
                    const page = mode === 'customer'
                        ? await db.loadMessages(data.conversation_id, client.customerId, data.before_message_id || null, client.catalogScope || null)
                        : (mode === 'database'
                        ? await db.loadGuestMessages(data.conversation_id, guestHistoryIdentity(client), data.before_message_id || null, client.catalogScope || null)
                            : await guestSessionHistory.loadMessages(guestHistoryIdentity(client), data.conversation_id, data.before_message_id || null));
                    const messages = await prepareHistoryMessages(
                        page.messages || [],
                        client,
                        data.conversation_id
                    );
                    logger.debug('conversation', 'sending conversation_messages:', { conversation_id: data.conversation_id, count: messages.length });
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
                    const mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig, client);
                    const deleted = mode === 'customer'
                        ? await db.deleteConversation(conversationId, client.customerId, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.deleteGuestConversation(conversationId, guestHistoryIdentity(client), client.catalogScope || null)
                            : await guestSessionHistory.delete(guestHistoryIdentity(client), conversationId));
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

                    const mode = client.customerId ? 'customer' : await guestHistoryMode(runtime, getAiConfig, client);
                    const updated = mode === 'customer'
                        ? await db.updateConversationTitle(data.conversation_id, client.customerId, title, client.catalogScope || null)
                        : (mode === 'database'
                            ? await db.updateGuestConversationTitle(data.conversation_id, guestHistoryIdentity(client), title, client.catalogScope || null)
                            : await guestSessionHistory.rename(guestHistoryIdentity(client), data.conversation_id, title));
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

// ==================== START ====================

async function startGateway() {
    await runtime.connect();
    addConfiguredWebSocketOrigins(allowedWebSocketOrigins, await getAiConfigSnapshot(runtime));
    server.listen(port, () => {
        logger.info('gateway', `AI Gateway replica ${runtime.instanceId} listening at http://localhost:${port} [WebSocket + REST]`);
        logger.info('gateway', `Shared Redis state: ${runtime.mode}; model concurrency cap: ${MAX_CONCURRENT_MODEL_REQUESTS}; queue cap: ${MAX_QUEUE_DEPTH}`);
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
