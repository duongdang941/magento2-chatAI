/**
 * WebSocket message handlers for the chat and catalog pagination actions.
 *
 * Extracted verbatim from the former server.js monolith. All shared state
 * (runtime, metrics, broadcasters, history codecs, run controller) arrives
 * through the dependency object so this module owns no global wiring.
 */
import {
    buildUserMessageDescriptor,
    recordOutboundAssistantPart,
    validateImageParts
} from '../conversation/message-parts.js';
import { buildInterruptedAssistantPayload } from '../conversation/interrupted-response.js';
import { attachRequestId, isAbortError } from '../conversation/active-run-controller.js';
import { rememberPendingVerificationAction } from '../conversation/pending-verification-action.js';
import { guestHistoryIdentity } from '../conversation/guest-history.js';
import {
    hasActiveGuestOrderAccess,
    hasActiveSupportEmailVerification,
    guestOrderAccessState
} from '../security/guest-access.js';
import { loadCatalogPage } from '../catalog/catalog-page-loader.js';
import {
    buildCatalogProductsPayload,
    verifyCatalogPageToken
} from '../catalog/catalog-pagination.js';
import { getOrchestrator } from '../orchestration/orchestrator-factory.js';
import { normalizeProviderResponseMetadata } from '../orchestration/provider-response-envelope.js';
import { admitImageRequest } from '../media/image-admission.js';
import { reportAssistantCompletion } from '../analytics/commerce-events.js';
import { reportGuardrailDecision } from '../policy/guardrail-audit.js';
import {
    isCustomerAddressChangeRequest,
    isOrderAddressChangeRequest,
    normalizeOrderAddressFormPart
} from '../customer/order-address-form.js';
import { getAiConfig } from '../configuration/config-service.js';
import { summarizeError } from './error-summary.js';
import { logger } from '../logger.js';
import * as db from './db-service.js';

export function createMessageHandlers(deps) {
    const {
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
    } = deps;

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

        const aiConfig = await getAiConfig(runtime, client.catalogScope?.storeCode || '', client.tenantId || client.catalogScope?.tenantId || '');
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
            logger.warn('catalog', 'Could not load the next page:', summarizeError(error));
            ws.send(JSON.stringify({
                type: 'product_page_error',
                product_part_id: productPartId,
                content: 'Could not load more products. Please try again.'
            }));
        }
    }

    async function handleChat(ws, data, client, requestConfig = null) {
        const { history = [], conversation_id } = data;
        const aiConfig = requestConfig || await getAiConfig(runtime, client.catalogScope?.storeCode || '', client.tenantId || client.catalogScope?.tenantId || '');
        const isResumedAction = data.resume_pending_action === true;
        const isContinuation = data.is_continuation === true;
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
                logger.debug('chat', `Handling authenticated message [conversation=${conversationId ? 'existing' : 'new'}]`);
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
                        logger.warn('chat', 'Requested conversation is unavailable; creating a new conversation.');
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
                    logger.debug('chat', 'Created conversation.');
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
                    if (isResumedAction || isContinuation) {
                        // A continuation or resumed action must execute it, not create a duplicate user message.
                        await db.touchConversation(conversationId, client.customerId, catalogScope);
                    } else {
                        const userMessageContent = currentUser.displayText || currentUser.text || '';
                        const attachment = buildUserMessageAttachmentPayload(currentUser, data);
                        savedUserMessageId = await db.saveMessage(
                            conversationId,
                            client.customerId,
                            'user',
                            userMessageContent,
                            attachment,
                            catalogScope
                        );
                        logger.debug('chat', 'Saved user message.');
                        ws.send(attachRequestId({
                            type: 'message_saved',
                            role: 'user',
                            entity_id: savedUserMessageId
                        }, run.requestId));
                        await db.touchConversation(conversationId, client.customerId, catalogScope);
                    }
                } catch (err) {
                    logger.error('chat', 'Failed to save user message:', err.message);
                }
            } catch (error) {
                logger.error('chat', 'Conversation setup failed:', summarizeError(error));
                ws.send(attachRequestId({ type: 'error', content: 'Could not start this conversation. Please try again in a moment.' }, run.requestId));
                clearActiveRun(ws, run);
                return;
            }
        } else {
            try {
                const requestedConversation = conversationId
                    ? (guestMode === 'database'
                        ? await db.getGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope)
                        : await guestSessionHistory.get(guestHistoryIdentity(client), conversationId))
                    : null;
                const page = requestedConversation ? null : (guestMode === 'database'
                    ? await db.listGuestConversations(guestHistoryIdentity(client), 1, catalogScope)
                    : await guestSessionHistory.list(guestHistoryIdentity(client), 1));
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
                        : await guestSessionHistory.create(guestHistoryIdentity(client), title);
                    conversationId = Number(conversation.id || conversation);
                    if (guestMode === 'session') {
                        await restoreGuestHistoryFromClient(history, guestHistoryIdentity(client), conversationId);
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

                if (isResumedAction || isContinuation) {
                    if (guestMode === 'database') {
                        await db.touchGuestConversation(conversationId, guestHistoryIdentity(client), catalogScope);
                    }
                } else if (guestMode === 'database') {
                    const attachment = buildUserMessageAttachmentPayload(currentUser, data);
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
                logger.error('chat', 'Guest conversation setup failed:', summarizeError(error));
                ws.send(attachRequestId({ type: 'error', content: 'Could not start this conversation. Please try again in a moment.' }, run.requestId));
                clearActiveRun(ws, run);
                return;
            }
        }

        let admission = null;
        let leaseHeartbeat = null;
        const processingStartedAt = Date.now();
        const assistantParts = [];
        let providerResponseMetadata = null;
        let interruptedResponsePersistence = null;

        const persistAssistantResponse = async (parts, metadata = {}, options = {}) => {
            const assistantPayload = buildAssistantStoragePayload(parts, metadata);
            if (!assistantPayload || !conversationId) {
                return false;
            }

            let savedMessageId = null;
            let persistent = false;
            const sendIfOpen = (payload) => {
                if (isSocketOpen(ws)) ws.send(payload);
            };
            if (client.customerId) {
                savedMessageId = await db.saveMessage(conversationId, client.customerId, 'assistant', assistantPayload, null, catalogScope);
                persistent = true;
                await db.touchConversation(conversationId, client.customerId, catalogScope);

                if (options.refreshTitle === true && !conversation_id) {
                    const newTitle = buildConversationTitle(currentUser.displayText || currentUser.text || '', {
                        hasImage: currentUser.hasImage
                    });
                    await db.updateConversationTitle(conversationId, client.customerId, newTitle, catalogScope);
                    sendIfOpen(JSON.stringify({ type: 'refresh_conversations' }));
                }
                sendIfOpen(attachRequestId({ type: 'message_saved', role: 'assistant', entity_id: savedMessageId, persistent }, run.requestId));
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

            sendIfOpen(attachRequestId({ type: 'message_saved', role: 'assistant', entity_id: savedMessageId, persistent }, run.requestId));
            void reportAssistantCompletion({
                config: aiConfig,
                client: { ...client, guestId: guestHistoryIdentity(client) },
                conversationId,
                messageId: savedMessageId,
                parts,
                durationMs: Date.now() - processingStartedAt
            });
            await broadcastGuestConversation(ws, client, guestMode, conversationId);
            sendIfOpen(JSON.stringify({ type: 'refresh_conversations' }));
            return true;
        };

        const persistInterruptedAssistantResponse = () => {
            if (interruptedResponsePersistence) {
                return interruptedResponsePersistence;
            }

            const interruptedResponse = buildInterruptedAssistantPayload(
                assistantParts,
                run.startedAt,
                Date.now(),
                run.interruptionReason
            );

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
            // Provider code is merchant-defined. The adapter is selected from the
            // synchronized provider protocol (api_format), so custom entries in
            // Magento use the same normalized streaming/tool pipeline.
            const streamChatResponse = await getOrchestrator(aiConfig.provider, aiConfig);

            // Collect the customer-visible streamed response for persistence.
            const wrappedWs = {
                send: (msgStr) => {
                    if (!isRunCancelled(run) && isSocketOpen(ws)) {
                        let outbound = attachRequestId(msgStr, run.requestId);
                        try {
                            const parsed = JSON.parse(outbound);
                            if (parsed.type === 'done' && parsed.provider_meta) {
                                providerResponseMetadata = normalizeProviderResponseMetadata(parsed.provider_meta);
                            }
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
                                        logger.warn('support', 'Could not clear expired email access:', summarizeError(error));
                                    });
                                } else {
                                    // Magento rejected or expired the short-lived
                                    // order token. Remove only the order cache.
                                    clearGuestOrderAccess(client).catch((error) => {
                                        logger.warn('guest-orders', 'Could not clear expired order access:', summarizeError(error));
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
                                        logger.warn('address-form', 'Could not activate form:', summarizeError(error));
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
                    logger.warn('chat', 'Could not persist interrupted response:', summarizeError(error));
                });
                notifyCancelled(ws, run);
                return;
            }

            await persistAssistantResponse(
                assistantParts,
                {
                    provider_meta: providerResponseMetadata,
                    worked_for_ms: Math.max(0, Date.now() - run.startedAt)
                },
                { refreshTitle: true }
            );

            metrics.increment('model_completed', { provider: aiConfig.provider });

        } catch (error) {
            if (isRunCancelled(run) || isAbortError(error)) {
                await persistInterruptedAssistantResponse().catch((persistenceError) => {
                    logger.warn('chat', 'Could not persist interrupted response:', summarizeError(persistenceError));
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
            logger.error('chat', 'Chat handler error:', summarizeError(error));
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

    return {
        handleProductPage,
        handleChat
    };
}
