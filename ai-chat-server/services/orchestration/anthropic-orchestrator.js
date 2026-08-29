import { summarizeError } from '../gateway/error-summary.js';
import { createSmoothChunkEmitter } from '../conversation/smooth-chunk-emitter.js';
import { toAnthropicContent } from '../conversation/message-parts.js';
import { emitProductPresentation } from '../catalog/product-presentation.js';
import { MAX_CATALOG_TOOL_ROUNDS } from '../catalog/catalog-agent-guidance.js';
import { createCustomerTurnBuffer } from '../conversation/customer-turn-buffer.js';
import { createResponseProgressPulse } from '../conversation/response-progress-pulse.js';
import { guestOrderAccessInstruction } from '../customer/guest-order-access-guidance.js';
import { anthropicToolDefinitions } from '../tools/tool-registry.js';
import { getProviderCapabilities } from '../providers/provider-capabilities.js';
import { buildAgentSystemInstruction } from './agent-system-guidance.js';
import { pageContextInstruction } from '../catalog/page-context.js';
import {
    EMPTY_RESPONSE_RECOVERY_INSTRUCTION,
    FINAL_SYNTHESIS_INSTRUCTION,
    isFinalSynthesisTurn
} from './tool-rounds.js';
import {
    formatProviderError,
    readProviderErrorResponse
} from '../providers/provider-error.js';
import {
    createProviderNeutralToolFlow,
    isBlockingToolFailure
} from './provider-neutral-tool-flow.js';
import {
    addProviderCitations,
    createProviderResponseEnvelope,
    finalizeProviderResponseEnvelope,
    mergeProviderUsage
} from './provider-response-envelope.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const configuredProviderStreamTimeout = Number(process.env.AI_PROVIDER_STREAM_TIMEOUT_MS || 120000);
const PROVIDER_STREAM_TIMEOUT_MS = Number.isFinite(configuredProviderStreamTimeout)
    ? Math.max(15000, Math.min(Math.trunc(configuredProviderStreamTimeout), 300000))
    : 120000;

function normalizeEndpointUrl(baseUrl) {
    let url = String(baseUrl || DEFAULT_ANTHROPIC_BASE_URL).trim().replace(/\/+$/, '');
    if (url.endsWith('/v1/messages') || url.endsWith('/messages')) {
        return url;
    }
    if (url.endsWith('/v1')) {
        return `${url}/messages`;
    }
    return `${url}/v1/messages`;
}

function formatAnthropicHistory(history) {
    if (!Array.isArray(history)) return [];
    const messages = [];

    for (const msg of history) {
        const role = (msg.role === 'model' || msg.role === 'assistant') ? 'assistant' : 'user';
        let textContent = '';
        if (typeof msg.content === 'string') {
            textContent = msg.content;
        } else if (typeof msg.text === 'string') {
            textContent = msg.text;
        }

        const content = toAnthropicContent(
            Array.isArray(msg.parts) ? msg.parts : [],
            textContent
        );
        if (Array.isArray(content) ? content.length > 0 : content) {
            messages.push({
                role,
                content
            });
        }
    }

    return messages;
}

export const streamChatResponse = async (userMessage, ws, history = [], customerToken = null, config = {}, options = {}) => {
    const signal = options.signal || null;
    const isCancelled = () => signal?.aborted || (typeof options.isCancelled === 'function' && options.isCancelled());

    const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY || '';
    const model = config.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    const baseUrl = config.base_url || DEFAULT_ANTHROPIC_BASE_URL;
    const endpointUrl = normalizeEndpointUrl(baseUrl);
    const agentConfig = config.agent || {};
    const currentUserMessage = typeof userMessage === 'object' && userMessage !== null
        ? userMessage
        : { text: userMessage };
    const currentUserText = String(currentUserMessage.text || currentUserMessage.content || '');

    const systemInstruction = [
        buildAgentSystemInstruction({
            extendedTools: true,
            productAdvisorEnabled: config.features?.product_advisor_enabled === true,
            shopperMessage: currentUserText
        }),
        `RUNTIME TOOL BUDGET: Use at most ${agentConfig.max_tool_rounds || 8} reasoning rounds. Finish from verified evidence.`,
        pageContextInstruction(options.pageContext),
        guestOrderAccessInstruction(options.customerId, options.guestOrderAccess)
    ].filter(Boolean).join('\n\n');

    const maxToolRounds = Math.max(1, Math.min(Number(agentConfig.max_tool_rounds) || MAX_CATALOG_TOOL_ROUNDS, 12));
    const maxOutputTokens = Math.max(256, Math.min(Number(agentConfig.max_output_tokens) || 4096, 1_000_000));
    const thinking = anthropicThinkingConfig(config.thought_level);
    const providerResponse = createProviderResponseEnvelope({
        provider: config.provider || 'anthropic',
        protocol: config.api_format || 'anthropic-messages',
        model
    });
    let finishReason = '';
    const providerStreamTimeoutMs = Math.max(15000, Math.min(Number(agentConfig.provider_stream_timeout_ms) || PROVIDER_STREAM_TIMEOUT_MS, 300000));

    const messages = [
        ...formatAnthropicHistory(history),
        {
            role: 'user',
            content: toAnthropicContent(
                Array.isArray(currentUserMessage.parts) ? currentUserMessage.parts : [],
                currentUserText
            )
        }
    ];

    const tools = anthropicToolDefinitions(config.provider || 'anthropic', getProviderCapabilities(config));
    const toolFlow = createProviderNeutralToolFlow({
        ws,
        customerToken,
        config,
        options,
        agentConfig,
        currentUserMessage,
        provider: config.provider || 'anthropic',
        providerConnection: { baseUrl, apiKey, model },
        signal,
        isCancelled
    });

    let hasVisibleText = false;
    let hasVisibleProducts = false;
    let hasVisibleImages = false;
    let lastToolOutcome = null;
    let toolErrorMessage = '';
    let pendingProductPresentation = null;
    let forceFinalSynthesis = false;
    let languageRepairAttempts = 0;
    let emptyResponseRecoveryAttempts = 0;
    let hasExecutedToolBatch = false;
    const progressPulse = createResponseProgressPulse({ ws, isCancelled });

    try {
        progressPulse.start();
        // Keep one request after the final tool batch for synthesis. Omitting
        // tool definitions on that request prevents a ninth tool execution.
        for (let iteration = 0; iteration <= maxToolRounds + 1; iteration += 1) {
            if (isCancelled()) return { cancelled: true };

            const mandatoryAvailabilityPending = toolFlow.shouldForceProductAvailability();
            const finalSynthesisOnly = !mandatoryAvailabilityPending && (
                forceFinalSynthesis
                || isFinalSynthesisTurn(iteration, maxToolRounds)
            );
            const requestSystemInstruction = finalSynthesisOnly
                ? `${systemInstruction}\n\n${FINAL_SYNTHESIS_INSTRUCTION}`
                : systemInstruction;

            const smoothEmitter = createSmoothChunkEmitter({
                emit: content => ws.send(JSON.stringify({ type: 'chunk', content })),
                isCancelled
            });
            const customerTurnBuffer = createCustomerTurnBuffer();

            const currentBlocks = [];
            let currentBlock = null;
            let currentToolUse = null;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), providerStreamTimeoutMs);
            const forwardAbort = () => controller.abort(signal?.reason);
            if (signal) signal.addEventListener('abort', forwardAbort, { once: true });

            try {
                const headers = {
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01',
                    'Accept': 'text/event-stream'
                };
                if (apiKey) {
                    headers['x-api-key'] = apiKey;
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                const response = await fetch(endpointUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages,
                        system: requestSystemInstruction,
                        max_tokens: thinking ? Math.max(maxOutputTokens, thinking.budget_tokens + 256) : maxOutputTokens,
                        stream: true,
                        ...(thinking ? { thinking } : {}),
                        ...(!finalSynthesisOnly && tools.length > 0 ? {
                            tools,
                            // After Magento has already returned a viable
                            // body-profile size dimension, a blank provider
                            // turn must not silently end the shopping flow.
                            // Force exactly the pending constrained retrieval;
                            // provider-neutral validation still rejects any
                            // unverified category, attribute, or option.
                            ...(toolFlow.shouldForceProductAvailability()
                                ? { tool_choice: { type: 'tool', name: 'getProductAvailability' } }
                                : toolFlow.shouldForceProductSearch()
                                    ? { tool_choice: { type: 'tool', name: 'searchProducts' } }
                                : {})
                        } : {})
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw await readProviderErrorResponse(response, 'AI provider');
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let sseBuffer = '';

                while (true) {
                    if (isCancelled()) return { cancelled: true };
                    const { value, done } = await reader.read();
                    if (done) break;

                    sseBuffer += decoder.decode(value, { stream: true });
                    const events = sseBuffer.split('\n\n');
                    sseBuffer = events.pop() || '';

                    for (const event of events) {
                        if (isCancelled()) return { cancelled: true };
                        const lines = event.split('\n').map(l => l.trim());
                        let eventType = '';
                        let dataStr = '';

                        for (const line of lines) {
                            if (line.startsWith('event:')) {
                                eventType = line.slice(6).trim();
                            } else if (line.startsWith('data:')) {
                                dataStr = line.slice(5).trim();
                            }
                        }

                        if (!dataStr) continue;

                        try {
                            const parsed = JSON.parse(dataStr);

                            if (parsed.message?.usage) mergeProviderUsage(providerResponse, parsed.message.usage);
                            if (parsed.usage) mergeProviderUsage(providerResponse, parsed.usage);
                            if (parsed.delta?.usage) mergeProviderUsage(providerResponse, parsed.delta.usage);
                            if (parsed.delta?.stop_reason) finishReason = parsed.delta.stop_reason;

                            if (eventType === 'content_block_start' || parsed.type === 'content_block_start') {
                                const cb = parsed.content_block || {};
                                if (cb.type === 'tool_use') {
                                    currentToolUse = {
                                        id: cb.id,
                                        name: cb.name,
                                        input_json: ''
                                    };
                                    currentBlocks.push({
                                        type: 'tool_use',
                                        id: cb.id,
                                        name: cb.name,
                                        input: {}
                                    });
                                } else if (cb.type === 'text') {
                                    currentBlock = { type: 'text', text: '' };
                                    currentBlocks.push(currentBlock);
                                } else if (cb.type === 'thinking') {
                                    currentBlock = { type: 'thinking', thinking: '', signature: '' };
                                    currentBlocks.push(currentBlock);
                                } else if (cb.type === 'redacted_thinking') {
                                    // Redacted reasoning is opaque server-side
                                    // state; it must be replayed verbatim on
                                    // later tool rounds or the API rejects the
                                    // follow-up request.
                                    currentBlocks.push({
                                        type: 'redacted_thinking',
                                        data: cb.data
                                    });
                                }
                                addProviderCitations(providerResponse, cb.citations);
                            } else if (eventType === 'content_block_delta' || parsed.type === 'content_block_delta') {
                                const delta = parsed.delta || {};
                                if (delta.type === 'text_delta') {
                                    if (currentBlock) currentBlock.text += delta.text;
                                    // Anthropic can narrate immediately before
                                    // selecting a tool. Hold that prose until
                                    // the turn boundary is known: it is either
                                    // final customer text or discarded as
                                    // private tool-selection narration.
                                    customerTurnBuffer.push(delta.text);
                                } else if (delta.type === 'thinking_delta') {
                                    if (currentBlock) currentBlock.thinking += delta.thinking;
                                } else if (delta.type === 'signature_delta') {
                                    // Thinking blocks replayed on the next tool
                                    // round need their signature or the API
                                    // rejects the follow-up request.
                                    if (currentBlock) currentBlock.signature += delta.signature || '';
                                } else if (delta.type === 'input_json_delta' && currentToolUse) {
                                    currentToolUse.input_json += delta.partial_json;
                                }
                            } else if (eventType === 'content_block_stop' || parsed.type === 'content_block_stop') {
                                if (currentToolUse) {
                                    try {
                                        const parsedArgs = JSON.parse(currentToolUse.input_json || '{}');
                                        const matching = currentBlocks.find(b => b.type === 'tool_use' && b.id === currentToolUse.id);
                                        if (matching) matching.input = parsedArgs;
                                    } catch {}
                                    currentToolUse = null;
                                }
                                currentBlock = null;
                            }
                        } catch (err) {
                            console.warn('[Anthropic Adapter] Error parsing event:', err.message);
                        }
                    }
                }

            } finally {
                clearTimeout(timeout);
                if (signal) signal.removeEventListener('abort', forwardAbort);
            }

            const rawToolCalls = currentBlocks.filter(b => b.type === 'tool_use');
            const toolCalls = finalSynthesisOnly ? [] : rawToolCalls;
            if (finalSynthesisOnly && rawToolCalls.length > 0) {
                console.warn('[Anthropic Adapter] Provider ignored the tool-free final synthesis turn.');
            }
            if (toolCalls.length === 0) {
                // A relay can ignore Anthropic's forced tool choice and
                // return prose after a configurable card. Fail closed: only
                // a live Magento availability response may release the final
                // shopper answer, never a search result's stock hint.
                if (mandatoryAvailabilityPending) {
                    customerTurnBuffer.discard();
                    const forcedToolUseId = `gateway-availability-${iteration}`;
                    const forcedAvailability = await toolFlow.execute({
                        id: forcedToolUseId,
                        name: 'getProductAvailability',
                        args: {}
                    });
                    lastToolOutcome = forcedAvailability.outcome || lastToolOutcome;
                    const toolState = toolFlow.getState();
                    hasVisibleProducts = toolState.hasVisibleProducts;
                    hasVisibleImages = toolState.hasVisibleImages;
                    pendingProductPresentation = toolState.pendingProductPresentation;
                    toolErrorMessage = toolState.toolErrorMessage || forcedAvailability.error || toolErrorMessage;
                    if (toolErrorMessage) {
                        toolFlow.completePendingActivity();
                        ws.send(JSON.stringify({
                            type: 'error',
                            content: `Magento tool failed: ${toolErrorMessage}`
                        }));
                        return { cancelled: false };
                    }

                    // Keep Anthropic history protocol-valid while making the
                    // enforced gateway result available for a tool-free
                    // synthesis turn.
                    messages.push({
                        role: 'assistant',
                        content: [{
                            type: 'tool_use',
                            id: forcedToolUseId,
                            name: 'getProductAvailability',
                            input: forcedAvailability.args
                        }]
                    });
                    messages.push({
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: forcedToolUseId,
                            content: JSON.stringify(forcedAvailability.modelContext)
                        }]
                    });
                    hasExecutedToolBatch = true;
                    forceFinalSynthesis = true;
                    continue;
                }
                const finalText = customerTurnBuffer.commit();
                const languageAssessment = toolFlow.assessFinalResponseLanguage(finalText);
                if (finalText
                    && !languageAssessment.accepted
                    && languageRepairAttempts < 1) {
                    languageRepairAttempts += 1;
                    forceFinalSynthesis = true;
                    messages.push({
                        role: 'user',
                        content: toolFlow.finalResponseLanguageRepairInstruction(languageAssessment)
                    });
                    continue;
                }
                if (!finalText && emptyResponseRecoveryAttempts < 1) {
                    emptyResponseRecoveryAttempts += 1;
                    forceFinalSynthesis = hasExecutedToolBatch;
                    messages.push({
                        role: 'user',
                        content: EMPTY_RESPONSE_RECOVERY_INSTRUCTION
                    });
                    continue;
                }
                if (finalText) {
                    smoothEmitter.push(finalText);
                    hasVisibleText = true;
                }
                await smoothEmitter.drain();
                // The final synthesis normally contains no new tool call.
                // Do not return here: a previous searchProducts call may have
                // prepared the shopper-facing grid and it must be emitted
                // immediately before the terminal `done` event below.
                break;
            }

            // Text emitted before a tool call is provider narration, not a
            // customer answer or a verified action. Keep it out of the
            // timeline; `tool_activity` is the sole customer-visible record.
            customerTurnBuffer.discard();

            // Append assistant response with tool_use blocks to message history
            messages.push({
                role: 'assistant',
                content: currentBlocks
            });
            hasExecutedToolBatch = true;

            // Execute tool calls
            const toolResults = [];
            for (const tc of toolCalls) {
                const callName = tc.name;
                const callArgs = tc.input || {};

                // Customer progress uses the same sanitized `tool_activity`
                // frames as the other adapters (emitted inside toolFlow).
                // Raw provider tool names and arguments never reach the browser.
                const outcome = await toolFlow.execute({
                    name: callName,
                    args: callArgs,
                    id: tc.id,
                    iteration
                });

                lastToolOutcome = outcome.outcome || lastToolOutcome;
                const toolResponse = outcome.modelContext;

                if (outcome.productPresentation) {
                    // Internal retrieval can refine its result set in one
                    // turn. The final accepted search is the only grid the
                    // shopper should receive.
                    pendingProductPresentation = outcome.productPresentation;
                }
                if (outcome.visibleProducts) {
                    hasVisibleProducts = true;
                }
                if (outcome.visibleImage) {
                    hasVisibleImages = true;
                }

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tc.id,
                    content: typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse)
                });

                if (outcome.error) {
                    toolErrorMessage = outcome.error;
                }
            }

            if (toolErrorMessage) {
                toolFlow.completePendingActivity();
                ws.send(JSON.stringify({
                    type: 'error',
                    content: `Magento tool failed: ${toolErrorMessage}`
                }));
                return { cancelled: false };
            }

            // Append tool results as user message in Anthropic format
            messages.push({
                role: 'user',
                content: toolResults
            });
        }

        if (!hasVisibleText) {
            toolFlow.completePendingActivity();
            ws.send(JSON.stringify({
                type: 'error',
                error_code: 'response_empty'
            }));
            return { cancelled: false, emptyResponse: true };
        }
        toolFlow.completePendingActivity();
        emitProductPresentation(ws, pendingProductPresentation);
        ws.send(JSON.stringify({
            type: 'done',
            provider_meta: finalizeProviderResponseEnvelope(providerResponse, finishReason || 'stop')
        }));

        return { cancelled: false, hasVisibleProse: hasVisibleText };
    } catch (error) {
        console.error('[Anthropic Adapter] Error during chat streaming:', summarizeError(error));
        toolFlow.completePendingActivity();
        ws.send(JSON.stringify({
            type: 'error',
            error_code: error.code || 'provider_error',
            content: formatProviderError(error, 'AI provider')
        }));
        return { cancelled: false, error };
    } finally {
        progressPulse.stop();
    }
};

function anthropicThinkingConfig(value) {
    const level = String(value || '').trim().toLowerCase();
    const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384 };
    return budgets[level]
        ? { type: 'enabled', budget_tokens: budgets[level] }
        : null;
}
