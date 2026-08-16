import {
    toOpenAiContent
} from '../conversation/message-parts.js';
import { summarizeError } from '../gateway/error-summary.js';
import { createSmoothChunkEmitter } from '../conversation/smooth-chunk-emitter.js';
import { emitProductPresentation } from '../catalog/product-presentation.js';
import {
    MAX_CATALOG_TOOL_ROUNDS
} from '../catalog/catalog-agent-guidance.js';
import { createCustomerTurnBuffer } from '../conversation/customer-turn-buffer.js';
import { createResponseProgressPulse } from '../conversation/response-progress-pulse.js';
import {
    guestOrderAccessInstruction
} from '../customer/guest-order-access-guidance.js';
import { openAiToolDefinitions } from '../tools/tool-registry.js';
import { buildAgentSystemInstruction } from './agent-system-guidance.js';
import { pageContextInstruction } from '../catalog/page-context.js';
import {
    buildFallbackMessage,
    createProviderNeutralToolFlow,
    isBlockingToolFailure
} from './provider-neutral-tool-flow.js';

const DEFAULT_BASE_URL = 'https://raud4eq.9router.com/v1';
const DEFAULT_FALLBACK_BASE_URL = 'https://aud4eq.tailabefe9.ts.net/v1';
const DEFAULT_MODEL = 'cx/gpt-5.5';
const DEFAULT_COCKPIT_BASE_URL = 'http://127.0.0.1:49998/v1';
const DEFAULT_COCKPIT_MODEL = 'gpt-5.6-luna';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.0-flash-001';
const configuredMaxOutputTokens = Number(process.env.AI_MAX_OUTPUT_TOKENS || 1536);
const MAX_OUTPUT_TOKENS = Number.isFinite(configuredMaxOutputTokens)
    ? Math.max(256, Math.min(Math.trunc(configuredMaxOutputTokens), 4096))
    : 1536;
const configuredProviderStreamTimeout = Number(process.env.AI_PROVIDER_STREAM_TIMEOUT_MS || 120000);
const PROVIDER_STREAM_TIMEOUT_MS = Number.isFinite(configuredProviderStreamTimeout)
    ? Math.max(15000, Math.min(Math.trunc(configuredProviderStreamTimeout), 300000))
    : 120000;
const PROVISIONAL_TEXT_HOLD_MS = 900;

const tools = openAiToolDefinitions();

export const streamChatResponse = async (userMessage, ws, history = [], customerToken = null, config = {}, options = {}) => {
    const signal = options.signal || null;
    const isCancelled = () => signal?.aborted || (typeof options.isCancelled === 'function' && options.isCancelled());
    const provider = getOpenAiCompatibleProvider(config.provider);
    const providerConfig = resolveProviderConfig(provider, config);
    const { apiKey, model, candidates, label } = providerConfig;
    const agentConfig = config.agent || {};
    const systemInstruction = buildAgentSystemInstruction({
        extendedTools: true,
        productAdvisorEnabled: config.features?.product_advisor_enabled === true
    });
    const maxToolRounds = Math.max(1, Math.min(Number(agentConfig.max_tool_rounds) || MAX_CATALOG_TOOL_ROUNDS, 12));
    const maxOutputTokens = Math.max(256, Math.min(Number(agentConfig.max_output_tokens) || MAX_OUTPUT_TOKENS, 8192));
    const providerStreamTimeoutMs = Math.max(
        10000,
        Math.min(Number(agentConfig.provider_stream_timeout_ms) || PROVIDER_STREAM_TIMEOUT_MS, 300000)
    );

    if (!apiKey) {
        ws.send(JSON.stringify({
            type: 'error',
            content: `${label} API key is missing. Configure the selected provider in Magento Admin or the gateway environment.`
        }));
        return { cancelled: false };
    }

    let baseUrl;
    try {
        baseUrl = await resolveReachableBaseUrl({
            apiKey,
            signal,
            candidates
        });
    } catch (error) {
        console.error(`[${label} Adapter] Unable to reach provider endpoint(s).`, {
            candidates,
            code: error?.cause?.code || error?.code || '',
            message: error?.message || ''
        });
        ws.send(JSON.stringify({
            type: 'error',
            content: formatProviderError(error, label)
        }));
        return { cancelled: false, error };
    }

    const currentUserMessage = typeof userMessage === 'object' && userMessage !== null
        ? userMessage
        : { text: userMessage };
    const messages = [
        {
            role: 'system',
            content: `${systemInstruction}\n\nRUNTIME TOOL BUDGET: Use at most ${maxToolRounds} reasoning rounds and ${agentConfig.max_tool_executions || 15} total tool executions. Blocked duplicate or over-budget calls must not be repeated; finish from verified evidence already returned.\n\n${pageContextInstruction(options.pageContext)}\n\n${guestOrderAccessInstruction(options.customerId, options.guestOrderAccess)}`
        },
        ...formatHistory(history),
        {
            role: 'user',
            content: toOpenAiContent(
                Array.isArray(currentUserMessage.parts) ? currentUserMessage.parts : [],
                currentUserMessage.text || currentUserMessage.content || ''
            )
        }
    ];
    const toolFlow = createProviderNeutralToolFlow({
        ws,
        customerToken,
        config,
        options,
        agentConfig,
        currentUserMessage,
        provider,
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
    const progressPulse = createResponseProgressPulse({ ws, isCancelled });

    try {
        progressPulse.start();
        for (let iteration = 0; iteration < maxToolRounds; iteration += 1) {
            if (isCancelled()) return { cancelled: true };

            const currentStepId = 'step-' + (iteration + 1) + '-' + Math.random().toString(36).slice(2, 7);
            const assistantMessage = {
                role: 'assistant',
                content: '',
                reasoning: '',
                tool_calls: []
            };
            const smoothEmitter = createSmoothChunkEmitter({
                emit: content => ws.send(JSON.stringify({ type: 'chunk', content })),
                isCancelled
            });
            let finishReason = '';
            for (let providerAttempt = 0; providerAttempt < 2; providerAttempt += 1) {
                const streamRequest = createProviderStreamSignal(signal, providerStreamTimeoutMs);
                try {
                    const response = await fetch(`${baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                            Accept: 'text/event-stream'
                        },
                        body: JSON.stringify({
                            model,
                            messages,
                            stream: true,
                            max_tokens: maxOutputTokens,
                            tools,
                            tool_choice: toolFlow.shouldForceProductSearch()
                                ? { type: 'function', function: { name: 'searchProducts' } }
                                : 'auto'
                        }),
                        signal: streamRequest.signal
                    });

                    if (!response.ok) {
                        throw await buildHttpError(response);
                    }

                    finishReason = await readOpenAiStream(response, {
                        onDelta: (delta) => {
                            if (isCancelled()) return;

                            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                                collectToolCalls(assistantMessage.tool_calls, delta.tool_calls);
                            }

                            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                                assistantMessage.reasoning += delta.reasoning_content;
                                ws.send(JSON.stringify({
                                    type: 'thinking_delta',
                                    step_id: currentStepId,
                                    delta: delta.reasoning_content
                                }));
                            }
                            if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
                                assistantMessage.reasoning += delta.reasoning;
                                ws.send(JSON.stringify({
                                    type: 'thinking_delta',
                                    step_id: currentStepId,
                                    delta: delta.reasoning
                                }));
                            }

                            if (typeof delta.content === 'string' && delta.content.length > 0) {
                                assistantMessage.content += delta.content;
                            }
                        },
                        isCancelled
                    });
                    break;
                } catch (error) {
                    const effectiveError = streamRequest.timedOut()
                        ? streamRequest.timeoutError
                        : error;
                    const canRetry = providerAttempt === 0
                        && assistantMessage.content.length === 0
                        && assistantMessage.tool_calls.length === 0
                        && isRetryableProviderError(effectiveError);
                    if (!canRetry) throw effectiveError;
                    await new Promise(resolve => setTimeout(resolve, 150));
                } finally {
                    streamRequest.dispose();
                }
            }

            if (finishReason === 'length') {
                console.warn(`[${label} Adapter] Provider reached the ${maxOutputTokens}-token output cap.`);
            }

            if (isCancelled()) return { cancelled: true };

            const toolCalls = assistantMessage.tool_calls.filter((toolCall) => toolCall?.function?.name);
            if (assistantMessage.content || toolCalls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: toolCalls.length > 0 ? null : (assistantMessage.content || null),
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                });
            }

            if (toolCalls.length === 0) {
                const finalCustomerText = (assistantMessage.content || '').trim();
                if (finalCustomerText) {
                    smoothEmitter.push(finalCustomerText);
                    hasVisibleText = true;
                }
                await smoothEmitter.drain();
                break;
            } else if (assistantMessage.content && assistantMessage.content.trim().length > 0) {
                ws.send(JSON.stringify({
                    type: 'thinking_step',
                    step_id: currentStepId,
                    content: assistantMessage.content.trim()
                }));
            }

            let stopAfterToolBatch = false;
            for (const toolCall of toolCalls) {
                if (isCancelled()) return { cancelled: true };

                const toolName = toolCall.function?.name || '';
                const rawToolArgs = parseToolArguments(toolCall.function?.arguments || '{}');
                const toolResult = await toolFlow.execute({
                    id: toolCall.id,
                    name: toolName,
                    args: rawToolArgs
                });
                const toolArgs = toolResult.args;
                // Keep the provider-visible tool history identical to the
                // guarded call that is actually sent to Magento.
                if (toolCall.function) {
                    toolCall.function.arguments = JSON.stringify(toolArgs);
                }
                lastToolOutcome = toolResult.outcome;
                if (toolResult.error) toolErrorMessage = toolResult.error;
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id || '',
                    content: JSON.stringify(toolResult.modelContext)
                });
                const toolState = toolFlow.getState();
                lastToolOutcome = toolState.lastToolOutcome || lastToolOutcome;
                hasVisibleProducts = toolState.hasVisibleProducts;
                hasVisibleImages = toolState.hasVisibleImages;
                pendingProductPresentation = toolState.pendingProductPresentation;
                toolErrorMessage = toolState.toolErrorMessage || toolErrorMessage;
                if (toolResult.stopAfterToolBatch) stopAfterToolBatch = true;
            }

            // Reaching the exact execution limit still permits one provider
            // synthesis turn. Stop only after the provider asks for an
            // additional execution beyond the configured budget.
            if (stopAfterToolBatch) break;

            if (toolErrorMessage) {
                ws.send(JSON.stringify({
                    type: 'error',
                    content: `Magento tool failed: ${toolErrorMessage}`
                }));
                return { cancelled: false };
            }

        }

        if (!hasVisibleText) {
            if (isCancelled()) return { cancelled: true };

            await emitFinalText(
                ws,
                buildFallbackMessage(),
                isCancelled
            );
        }

        if (isCancelled()) return { cancelled: true };

        // Retrieval is internal model evidence. Publish exactly one final
        // product result after the customer-facing prose has completed.
        emitProductPresentation(ws, pendingProductPresentation);
        ws.send(JSON.stringify({ type: 'done' }));
        return { cancelled: false };
    } catch (error) {
        if (isCancelled() || error.name === 'AbortError' || /abort|aborted/i.test(error.message || '')) {
            return { cancelled: true };
        }

        console.error(`[${label} Adapter]`, summarizeError(error));
        ws.send(JSON.stringify({ type: 'error', content: formatProviderError(error, label) }));
        return { cancelled: false, error };
    } finally {
        progressPulse.stop();
    }
};

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getOpenAiCompatibleProvider(value) {
    return ['openai', 'openrouter', '9router', 'cockpit'].includes(value) ? value : '9router';
}

function resolveProviderConfig(provider, config = {}) {
    switch (provider) {
        case 'openai':
            return {
                apiKey: config.api_key || process.env.OPENAI_API_KEY || '',
                model: config.model || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
                candidates: [normalizeBaseUrl(config.base_url || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL)],
                label: 'OpenAI'
            };
        case 'openrouter':
            return {
                apiKey: config.api_key || process.env.OPENROUTER_API_KEY || '',
                model: config.model || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
                candidates: [normalizeBaseUrl(config.base_url || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL)],
                label: 'OpenRouter'
            };
        case 'cockpit':
            return {
                apiKey: config.api_key || process.env.COCKPIT_API_KEY || '',
                model: config.model || process.env.COCKPIT_MODEL || DEFAULT_COCKPIT_MODEL,
                candidates: buildCockpitBaseUrlCandidates(config),
                label: 'Cockpit'
            };
        case '9router':
        default:
            return {
                apiKey: config.api_key || process.env.NINE_ROUTER_API_KEY || '',
                model: config.model || process.env.NINE_ROUTER_MODEL || DEFAULT_MODEL,
                candidates: buildBaseUrlCandidates(config),
                label: '9router'
            };
    }
}

function buildBaseUrlCandidates(config = {}) {
    const configured = normalizeBaseUrl(config.base_url || process.env.NINE_ROUTER_BASE_URL || DEFAULT_BASE_URL);
    const publicBase = normalizeBaseUrl(DEFAULT_BASE_URL);
    const fallback = normalizeBaseUrl(process.env.NINE_ROUTER_FALLBACK_BASE_URL || DEFAULT_FALLBACK_BASE_URL);
    return Array.from(new Set([configured, publicBase, fallback].filter(Boolean)));
}

function buildCockpitBaseUrlCandidates(config = {}) {
    const configured = normalizeBaseUrl(
        config.base_url || process.env.COCKPIT_BASE_URL || DEFAULT_COCKPIT_BASE_URL
    );
    // Cockpit is local-only. Never fall back to a remote provider from this lane.
    return configured ? [configured] : [];
}

async function resolveReachableBaseUrl({ apiKey, signal, candidates }) {
    let lastError = null;

    for (const candidate of candidates) {
        try {
            const response = await fetch(`${candidate}/models`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                },
                signal
            });

            if (response.ok) {
                return candidate;
            }

            const error = new Error(`Base URL ${candidate} returned HTTP ${response.status}`);
            error.status = response.status;
            lastError = error;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Unable to reach 9router endpoints.');
}

function formatHistory(history) {
    if (!Array.isArray(history)) return [];

    return history
        .map((message) => {
            const role = message.role === 'model' ? 'assistant' : message.role;
            if (!['user', 'assistant'].includes(role)) return null;

            const content = toOpenAiContent(
                Array.isArray(message.parts) ? message.parts : [],
                message.content || message.text || ''
            );

            if (Array.isArray(content)) {
                return content.length > 0 ? { role, content } : null;
            }

            const trimmed = String(content || '').trim();
            return trimmed ? { role, content: trimmed } : null;
        })
        .filter(Boolean);
}

function createProviderStreamSignal(parentSignal, timeoutMs = PROVIDER_STREAM_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutError = new Error('The AI provider response timed out.');
    timeoutError.code = 'PROVIDER_STREAM_TIMEOUT';
    const forwardParentAbort = () => controller.abort(parentSignal?.reason);
    const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);

    if (parentSignal) {
        if (parentSignal.aborted) {
            forwardParentAbort();
        } else {
            parentSignal.addEventListener('abort', forwardParentAbort, { once: true });
        }
    }

    return {
        signal: controller.signal,
        timeoutError,
        timedOut: () => controller.signal.reason === timeoutError,
        dispose: () => {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', forwardParentAbort);
        }
    };
}

async function readOpenAiStream(response, { onDelta, isCancelled }) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = '';

    while (true) {
        if (isCancelled()) return;

        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
            if (isCancelled()) return;

            const lines = event.split('\n').map((line) => line.trim());
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;

                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(payload);
                    const choice = parsed.choices?.[0] || {};
                    const delta = choice.delta || {};
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                    onDelta(delta);
                } catch (error) {
                    console.warn('[OpenAI-compatible] Could not parse stream chunk:', error.message);
                }
            }
        }
    }

    return finishReason;
}

/**
 * Used only for deterministic fallbacks. Provider prose itself is forwarded
 * immediately in onDelta so the customer receives genuine streaming tokens.
 */
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

function collectToolCalls(collected, deltas) {
    for (const delta of deltas) {
        const index = Number.isInteger(delta.index) ? delta.index : collected.length;
        if (!collected[index]) {
            collected[index] = {
                id: delta.id || `call_${index}`,
                type: 'function',
                function: {
                    name: '',
                    arguments: ''
                }
            };
        }

        if (delta.id) collected[index].id = delta.id;
        if (delta.type) collected[index].type = delta.type;
        if (delta.function?.name) collected[index].function.name += delta.function.name;
        if (delta.function?.arguments) collected[index].function.arguments += delta.function.arguments;
    }
}

function parseToolArguments(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function buildHttpError(response) {
    const text = await response.text();
    let message = text;
    try {
        const parsed = JSON.parse(text);
        message = parsed.error?.message || parsed.message || text;
    } catch {}

    const error = new Error(message || `Provider returned HTTP ${response.status}`);
    error.status = response.status;
    return error;
}

function formatProviderError(error, providerLabel = '9router') {
    const message = String(error?.message || '');
    const code = String(error?.cause?.code || error?.code || '');
    const baseUrlHint = providerLabel === '9router'
        ? 'Please check the public/tailnet base_url in configuration.'
        : 'Please check the base_url in configuration.';

    if (error?.code === 'PROVIDER_STREAM_TIMEOUT') {
        return 'The AI service took too long to complete. Please try again with a shorter request.';
    }

    const httpStatusMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (httpStatusMatch) {
        const status = Number(httpStatusMatch[1]);
        if (status >= 500) {
            return `${providerLabel} endpoint returned HTTP ${status}. ${baseUrlHint}`;
        }
    }

    if (Number.isInteger(error?.status) && error.status >= 500) {
        return `${providerLabel} endpoint returned HTTP ${error.status}. ${baseUrlHint}`;
    }

    if (error?.status === 429 || /quota|too many requests|rate[- ]?limit/i.test(message)) {
        return 'The AI provider is temporarily rate limited. Please try again in a moment.';
    }

    if (error?.status === 401 || error?.status === 403 || /api key|permission|unauthorized|forbidden/i.test(message)) {
        return 'The AI provider credentials are not valid. Please check the AI configuration.';
    }

    if (/invalid image|image data.*valid image|does not represent a valid image|corrupt image|malformed image/i.test(message)) {
        return 'The uploaded image is invalid or could not be read. Please try a different JPG, PNG, or WebP image.';
    }

    if (/image|vision|multimodal|image_url|inline_data|unsupported.*image/i.test(message)) {
        return 'The current AI model does not support images. Please switch to a vision-capable model or check your provider settings.';
    }

    if (code === 'ENOTFOUND'
        || code === 'EAI_AGAIN'
        || code === 'ECONNREFUSED'
        || code === 'ETIMEDOUT'
        || /fetch failed|getaddrinfo|network|dns|timeout|ENOTFOUND/i.test(message)) {
        return `Could not connect to ${providerLabel} from server. Please check DNS/base_url and gateway network.`;
    }

    return 'The AI service could not complete this response. Please try again.';
}

function isRetryableProviderError(error) {
    if ([502, 503, 504].includes(Number(error?.status))) return true;
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'PROVIDER_STREAM_TIMEOUT'].includes(code)) return true;
    return /(?:upstream|gateway|provider).*(?:timeout|timed out)|fetch failed|socket hang up/i.test(
        String(error?.message || '')
    );
}

export {
    buildFallbackMessage,
    buildBaseUrlCandidates,
    formatProviderError,
    isBlockingToolFailure,
    isRetryableProviderError,
    resolveReachableBaseUrl,
    resolveProviderConfig
};
