import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    toGeminiParts
} from '../conversation/message-parts.js';
import { summarizeError } from '../gateway/error-summary.js';
import { createSmoothChunkEmitter } from '../conversation/smooth-chunk-emitter.js';
import { logger } from '../logger.js';
import { emitProductPresentation } from '../catalog/product-presentation.js';
import {
    MAX_CATALOG_TOOL_ROUNDS
} from '../catalog/catalog-agent-guidance.js';
import { createResponseProgressPulse } from '../conversation/response-progress-pulse.js';
import {
    guestOrderAccessInstruction
} from '../customer/guest-order-access-guidance.js';
import { geminiToolDefinitions } from '../tools/tool-registry.js';
import { getProviderCapabilities } from '../providers/provider-capabilities.js';
import { buildAgentSystemInstruction } from './agent-system-guidance.js';
import { pageContextInstruction } from '../catalog/page-context.js';
import {
    FINAL_SYNTHESIS_INSTRUCTION,
    isFinalSynthesisTurn
} from './tool-rounds.js';
import {
    buildFallbackMessage,
    createProviderNeutralToolFlow
} from './provider-neutral-tool-flow.js';
import {
    addProviderCitations,
    createProviderResponseEnvelope,
    finalizeProviderResponseEnvelope,
    mergeProviderUsage
} from './provider-response-envelope.js';

// ==================== TOOLS DEFINITION ====================

// Gemini now receives the same canonical tool surface as every
// OpenAI-compatible adapter. Provider-specific capabilities still report a
// clear unavailable result at execution time when needed.
// ==================== ORCHESTRATOR ====================

export const streamChatResponse = async (userMessage, ws, history = [], customerToken = null, config = {}, options = {}) => {
    let progressPulse = null;
    try {
        const signal = options.signal || null;
        const isCancelled = () => signal?.aborted || (typeof options.isCancelled === 'function' && options.isCancelled());
        progressPulse = createResponseProgressPulse({ ws, isCancelled });
        progressPulse.start();
        const apiKey = config.api_key || process.env.GEMINI_API_KEY;
        const modelName = config.model || "gemini-1.5-flash";
        const agentConfig = config.agent || {};
        const tools = geminiToolDefinitions(getProviderCapabilities(config));
        const currentUserMessage = typeof userMessage === 'object' && userMessage !== null
            ? userMessage
            : { text: userMessage };
        const currentUserText = String(currentUserMessage.text || currentUserMessage.content || '');
        const systemInstruction = buildAgentSystemInstruction({
            extendedTools: true,
            productAdvisorEnabled: config.features?.product_advisor_enabled === true,
            shopperMessage: currentUserText
        });
        const maxToolRounds = Math.max(1, Math.min(Number(agentConfig.max_tool_rounds) || MAX_CATALOG_TOOL_ROUNDS, 12));
        const maxOutputTokens = Math.max(256, Math.min(Number(agentConfig.max_output_tokens) || 2048, 1_000_000));
        const providerTimeoutMs = Math.max(10000, Math.min(Number(agentConfig.provider_stream_timeout_ms) || 120000, 300000));
        const providerResponse = createProviderResponseEnvelope({
            provider: config.provider || 'gemini',
            protocol: config.api_format || 'gemini-stream',
            model: modelName
        });
        let finishReason = '';

        logger.debug('gemini', `Starting stream with model: ${modelName}`);

        if (!apiKey) {
            ws.send(JSON.stringify({
                type: 'error',
                content: 'Missing GEMINI_API_KEY. Configure the selected provider key in ai-chat-server/.env or environment variables.'
            }));
            return;
        }

        const toolFlow = createProviderNeutralToolFlow({
            ws,
            customerToken,
            config,
            options,
            agentConfig,
            currentUserMessage,
            provider: config.provider || 'gemini',
            providerConnection: {
                baseUrl: config.base_url || process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta',
                apiKey,
                model: config.grounding_model || process.env.GEMINI_MODEL_GROUNDING || modelName
            },
            signal,
            isCancelled
        });
        const genAI = new GoogleGenerativeAI(apiKey);
        const runtimeSystemInstruction = `${systemInstruction}\n\nRUNTIME TOOL BUDGET: Use at most ${maxToolRounds} reasoning rounds and ${agentConfig.max_tool_executions || 15} total tool executions. Blocked duplicate or over-budget calls must not be repeated; finish from verified evidence already returned.\n\n${pageContextInstruction(options.pageContext)}\n\n${guestOrderAccessInstruction(options.customerId, options.guestOrderAccess)}`;
        const model = genAI.getGenerativeModel({
            model: modelName,
            tools,
            generationConfig: { maxOutputTokens },
            systemInstruction: runtimeSystemInstruction
        });
        const finalSynthesisModel = genAI.getGenerativeModel({
            model: modelName,
            tools,
            generationConfig: { maxOutputTokens },
            systemInstruction: `${runtimeSystemInstruction}\n\n${FINAL_SYNTHESIS_INSTRUCTION}`
        });
        // Prepare History in API format
        const chatHistory = history
            .map(h => {
                const parts = toGeminiParts(Array.isArray(h.parts) ? h.parts : [], h.content || h.text || '');
                if (!parts.length) {
                    return null;
                }

                return {
                    role: h.role === 'assistant' ? 'model' : h.role,
                    parts
                };
            })
            .filter(Boolean);

        // Add the current user message to history
        chatHistory.push({
            role: 'user',
            parts: toGeminiParts(
                Array.isArray(currentUserMessage.parts) ? currentUserMessage.parts : [],
                currentUserMessage.text || currentUserMessage.content || ''
            )
        });
        let hasVisibleText = false;
        let hasVisibleProducts = false;
        let lastToolOutcome = null;
        let toolErrorMessage = '';
        let pendingProductPresentation = null;

        // Reserve one final, tool-free Gemini request after the last allowed
        // tool batch so the model can produce its customer-facing synthesis.
        for (let iteration = 0; iteration <= maxToolRounds; iteration += 1) {
            if (isCancelled()) {
                return { cancelled: true };
            }

            const finalSynthesisOnly = isFinalSynthesisTurn(iteration, maxToolRounds);
            const turnNumber = iteration + 1;
            logger.debug('gemini', `Iteration ${turnNumber}, Turn: ${chatHistory[chatHistory.length - 1].role}`);

            // Keep tool-selection policy provider-neutral. Gemini needs its
            // own wire format, but the decision comes from the same shared
            // catalogue policy as OpenAI-compatible providers.
            const request = {
                contents: chatHistory,
                ...(finalSynthesisOnly ? {
                    toolConfig: {
                        functionCallingConfig: { mode: 'NONE' }
                    }
                } : toolFlow.shouldForceProductSearch() ? {
                    toolConfig: {
                        functionCallingConfig: {
                            mode: 'ANY',
                            allowedFunctionNames: ['searchProducts']
                        }
                    }
                } : {})
            };
            const result = await (finalSynthesisOnly ? finalSynthesisModel : model).generateContentStream(request, {
                ...(signal ? { signal } : {}),
                timeout: providerTimeoutMs
            });

            let combinedParts = [];
            let functionCalls = [];
            const smoothEmitter = createSmoothChunkEmitter({
                emit: content => ws.send(JSON.stringify({ type: 'chunk', content })),
                isCancelled
            });
            for await (const chunk of result.stream) {
                if (isCancelled()) {
                    return { cancelled: true };
                }

                const parts = chunk.candidates?.[0]?.content?.parts;
                mergeProviderUsage(providerResponse, chunk.usageMetadata);
                finishReason = chunk.candidates?.[0]?.finishReason || finishReason;
                    addProviderCitations(providerResponse, chunk.candidates?.[0]?.groundingMetadata?.groundingChunks);
                    if (parts) {
                        for (const part of parts) {
                            if (part.thought === true || part.thought) {
                                // Provider thoughts are private. Storefront progress is
                                // represented only by verified tool_activity events.
                                continue;
                            } else if (part.text) {
                                smoothEmitter.push(part.text);
                                hasVisibleText = true;
                            }

                        const normalizedPart = normalizeGeminiModelPart(part);
                        if (normalizedPart) {
                            combinedParts.push(normalizedPart);
                        }
                    }
                }
                
                // Track function calls for immediate execution logic
                try {
                    const calls = chunk.functionCalls();
                    if (calls) functionCalls.push(...calls);
                } catch (e) {}
            }

            if (combinedParts.length > 0) {
                chatHistory.push({
                    role: 'model',
                    parts: combinedParts
                });
            }

            if (isCancelled()) {
                return { cancelled: true };
            }

            // If AI did not call any tools, this is the final customer answer
            const toolCalls = finalSynthesisOnly ? [] : functionCalls;
            if (finalSynthesisOnly && functionCalls.length > 0) {
                logger.warn('gemini', 'Provider ignored the tool-free final synthesis turn.');
            }

            if (toolCalls.length === 0) {
                await smoothEmitter.drain();
                break;
            }
                // Gemini can return several function calls in one model turn,
                // but the customer timeline is deliberately serial.  Starting
                // call B only after call A has returned lets A stay “running”
                // for its entire real execution and lets the shared tool flow
                // mark it complete at the exact moment B begins.
                const execution = await executeGeminiFunctionCallsInOrder(
                    toolCalls,
                    async (fnCall) => {
                        const result = await toolFlow.execute({
                            id: fnCall.id,
                            name: fnCall.name,
                            args: fnCall.args
                        });
                        return {
                            ...result,
                            functionResponse: createGeminiFunctionResponsePart(result.name, result.modelContext)
                        };
                    },
                    isCancelled
                );

                if (execution.cancelled) {
                    return { cancelled: true };
                }

                const completedFunctionResponses = execution.responses;
                // Preserve the model's declared order for the provider history
                // and for choosing the final card, terminal result, or fallback.
                const toolState = toolFlow.reconcile(completedFunctionResponses);
                lastToolOutcome = toolState.lastToolOutcome || lastToolOutcome;
                hasVisibleProducts = toolState.hasVisibleProducts;
                pendingProductPresentation = toolState.pendingProductPresentation;
                toolErrorMessage = toolState.toolErrorMessage || toolErrorMessage;

                // Append provider-compatible function responses to history.
                chatHistory.push({
                    role: 'function',
                    parts: completedFunctionResponses.map(result => result.functionResponse)
                });

                if (toolErrorMessage) {
                    toolFlow.completePendingActivity();
                    ws.send(JSON.stringify({
                        type: 'error',
                        content: `Magento tool failed: ${toolErrorMessage}`
                    }));
                    // Match the OpenAI/Anthropic adapters: a blocking tool
                    // failure terminates the turn without a `done` frame.
                    return { cancelled: false };
                }
        }

        if (!hasVisibleText) {
            if (isCancelled()) {
                return { cancelled: true };
            }

            await emitFinalText(
                ws,
                buildFallbackMessage(),
                isCancelled
            );
        }

        if (isCancelled()) {
            return { cancelled: true };
        }

        toolFlow.completePendingActivity();
        emitProductPresentation(ws, pendingProductPresentation);
        ws.send(JSON.stringify({
            type: 'done',
            provider_meta: finalizeProviderResponseEnvelope(providerResponse, finishReason || 'stop')
        }));
        return { cancelled: false };

    } catch (error) {
        if (options.signal?.aborted || error.name === 'AbortError' || /abort|aborted/i.test(error.message || '')) {
            return { cancelled: true };
        }

        console.error('Gemini Orchestrator Error:', summarizeError(error));
        toolFlow.completePendingActivity();
        ws.send(JSON.stringify({ type: 'error', content: formatGeminiError(error) }));
        return { cancelled: false, error };
    } finally {
        progressPulse?.stop();
    }
};

/**
 * Gemini function results must be a Part containing `functionResponse`.
 *
 * The model's call is already stored as a `functionCall` Part. Sending the
 * response fields directly as a Part makes the next Gemini turn fail schema
 * validation after Magento has finished a tool request.
 */
export function createGeminiFunctionResponsePart(name, content) {
    return {
        functionResponse: {
            name: String(name || ''),
            response: { content }
        }
    };
}

/**
 * Execute one Gemini function batch in strict model order.
 *
 * Parallel Magento calls make a “completed” activity ambiguous: a later call
 * can be announced before the earlier action has actually finished.  The
 * storefront contract instead presents one continuous action at a time.
 */
export async function executeGeminiFunctionCallsInOrder(functionCalls, execute, isCancelled = () => false) {
    const responses = [];
    for (const fnCall of Array.isArray(functionCalls) ? functionCalls : []) {
        if (isCancelled()) return { cancelled: true, responses };
        const response = await execute(fnCall);
        if (response) responses.push(response);
    }
    return { cancelled: isCancelled(), responses };
}

/**
 * The Gemini SDK normally returns canonical Part objects, but some model
 * responses include convenience fields alongside a functionCall (for example
 * a top-level `name`). Sending those fields back in the next request makes the
 * Gemini API reject the entire turn with "Unknown name ... at contents[..]".
 * Keep only fields accepted by the Gemini Part schema before retaining the
 * model turn in chat history.
 */
export function normalizeGeminiModelPart(part) {
    if (!part || typeof part !== 'object') return null;

    if (typeof part.text === 'string' && part.text) {
        return {
            text: part.text,
            ...(typeof part.thoughtSignature === 'string' && part.thoughtSignature
                ? { thoughtSignature: part.thoughtSignature }
                : {})
        };
    }

    const functionCall = part.functionCall || part.function_call;
    if (functionCall && typeof functionCall === 'object' && String(functionCall.name || '').trim()) {
        return {
            functionCall: {
                name: String(functionCall.name).trim(),
                args: functionCall.args && typeof functionCall.args === 'object'
                    ? functionCall.args
                    : {}
            },
            ...(typeof part.thoughtSignature === 'string' && part.thoughtSignature
                ? { thoughtSignature: part.thoughtSignature }
                : {})
        };
    }

    const inlineData = part.inlineData || part.inline_data;
    if (inlineData && typeof inlineData === 'object') {
        const mimeType = String(inlineData.mimeType || inlineData.mime_type || '').trim();
        const data = String(inlineData.data || '').trim();
        if (mimeType && data) {
            return { inlineData: { mimeType, data } };
        }
    }

    return null;
}

function formatGeminiError(error) {
    const message = String(error?.message || '');
    if (error?.status === 429 || /quota|too many requests|rate[- ]?limit/i.test(message)) {
        return 'The AI provider is temporarily rate limited. Please try again in a moment.';
    }

    if (error?.status === 401 || error?.status === 403 || /api key|permission|unauthorized|forbidden/i.test(message)) {
        return 'The AI provider credentials are not valid. Please check the AI configuration.';
    }

    if (/invalid image|image data.*valid image|does not represent a valid image|corrupt image|malformed image/i.test(message)) {
        return 'The uploaded image is invalid or could not be read. Please try a different JPG, PNG, or WebP image.';
    }

    if (/image|vision|multimodal|inline_data|unsupported.*image/i.test(message)) {
        return 'The current AI model does not support images. Please switch to a vision-capable model or check your provider settings.';
    }

    return 'The AI service could not complete this response. Please try again.';
}

async function emitFinalText(ws, content, isCancelled) {
    const text = String(content || '');
    const chunkSize = 72;

    for (let offset = 0; offset < text.length; offset += chunkSize) {
        if (isCancelled()) return;

        ws.send(JSON.stringify({
            type: 'chunk',
            content: text.slice(offset, offset + chunkSize)
        }));

        if (offset + chunkSize < text.length) {
            await new Promise((resolve) => setTimeout(resolve, 8));
        }
    }
}
