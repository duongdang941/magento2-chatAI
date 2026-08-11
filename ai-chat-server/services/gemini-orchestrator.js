import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    toGeminiParts
} from './message-parts.js';
import { summarizeError } from './error-summary.js';
import { createSmoothChunkEmitter } from './smooth-chunk-emitter.js';
import {
    createCatalogToolPresentation,
    emitProductPresentation
} from './product-presentation.js';
import {
    MAX_CATALOG_TOOL_ROUNDS,
    catalogCoverageInstruction
} from './catalog-agent-guidance.js';
import {
    createToolActivityId,
    emitToolActivity
} from './tool-activity.js';
import { createCustomerResponseStreamSanitizer } from './customer-response-sanitizer.js';
import { createToolExecutionBudget, toolBudgetMessage } from './tool-execution-budget.js';
import { buildCustomerAddressFormPayload, buildOrderAddressFormPayload } from './order-address-form.js';
import {
    guestOrderAccessInstruction
} from './guest-order-access-guidance.js';
import {
    responseLanguageInstruction
} from './response-language-guidance.js';
import {
    isResolvedCatalogIdentity,
    isTerminalCatalogMiss,
    resolvedCatalogIdentityBlock,
    unavailableCatalogMessage
} from './catalog-tool-outcome.js';
import { geminiToolDefinitions } from './tools/tool-registry.js';
import { buildAgentSystemInstruction } from './agent-system-guidance.js';
import { executeRegisteredMagentoTool } from './tools/magento-tool-executor.js';
import { createCatalogQueryContinuity } from './catalog-query-continuity.js';

// ==================== TOOLS DEFINITION ====================

const tools = geminiToolDefinitions();

const systemInstruction = buildAgentSystemInstruction();

// ==================== ORCHESTRATOR ====================

export const streamChatResponse = async (userMessage, ws, history = [], customerToken = null, config = {}, options = {}) => {
    try {
        const signal = options.signal || null;
        const isCancelled = () => signal?.aborted || (typeof options.isCancelled === 'function' && options.isCancelled());
        const apiKey = config.api_key || process.env.GEMINI_API_KEY;
        const modelName = config.model || "gemini-1.5-flash";
        const agentConfig = config.agent || {};
        const maxToolRounds = Math.max(1, Math.min(Number(agentConfig.max_tool_rounds) || MAX_CATALOG_TOOL_ROUNDS, 12));
        const maxOutputTokens = Math.max(256, Math.min(Number(agentConfig.max_output_tokens) || 2048, 8192));
        const providerTimeoutMs = Math.max(10000, Math.min(Number(agentConfig.provider_stream_timeout_ms) || 120000, 300000));
        const toolBudget = createToolExecutionBudget(agentConfig);
        const catalogQueryContinuity = createCatalogQueryContinuity();

        console.log(`[Gemini] Starting stream with model: ${modelName}`);

        if (!apiKey) {
            ws.send(JSON.stringify({
                type: 'error',
                content: 'Missing GEMINI_API_KEY. Configure the selected provider key in ai-chat-server/.env or environment variables.'
            }));
            return;
        }

        const currentUserMessage = typeof userMessage === 'object' && userMessage !== null
            ? userMessage
            : { text: userMessage };
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: modelName,
            tools,
            generationConfig: { maxOutputTokens },
            systemInstruction: `${systemInstruction}\n\nRUNTIME TOOL BUDGET: Use at most ${maxToolRounds} reasoning rounds and ${agentConfig.max_tool_executions || 15} total tool executions. Blocked duplicate or over-budget calls must not be repeated; finish from verified evidence already returned.\n\n${guestOrderAccessInstruction(options.customerId, options.guestOrderAccess)}`
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
        const preferredAddress = extractPreferredAddress(history);

        let isDone = false;
        let iteration = 0;
        let hasVisibleText = false;
        let hasVisibleProducts = false;
        let lastToolOutcome = null;
        let toolErrorMessage = '';
        let pendingProductPresentation = null;
        let terminalCatalogMessage = '';
        let catalogIdentityResolved = false;

        while (!isDone && iteration < maxToolRounds) {
            if (isCancelled()) {
                return { cancelled: true };
            }

            iteration++;
            console.log(`[Gemini] Iteration ${iteration}, Turn: ${chatHistory[chatHistory.length - 1].role}`);

            const request = { contents: chatHistory };
            const result = await model.generateContentStream(request, {
                ...(signal ? { signal } : {}),
                timeout: providerTimeoutMs
            });

            let combinedParts = [];
            let functionCalls = [];
            let streamedTextThisTurn = false;
            const responseSanitizer = createCustomerResponseStreamSanitizer();
            const smoothEmitter = createSmoothChunkEmitter({
                emit: content => ws.send(JSON.stringify({ type: 'chunk', content })),
                isCancelled
            });
            const emitCustomerText = (content) => {
                const safeContent = responseSanitizer.push(content);
                if (!safeContent) return;

                hasVisibleText = true;
                streamedTextThisTurn = true;
                smoothEmitter.push(safeContent);
            };

            for await (const chunk of result.stream) {
                if (isCancelled()) {
                    return { cancelled: true };
                }

                const parts = chunk.candidates?.[0]?.content?.parts;
                if (parts) {
                    for (const part of parts) {
                        if (part.text) {
                            emitCustomerText(part.text);
                        }

                        combinedParts.push(part);
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

            // If AI called tools, we need to execute and continue
            if (functionCalls.length > 0) {
                responseSanitizer.discard();
                await smoothEmitter.drain();
                if (streamedTextThisTurn) {
                    ws.send(JSON.stringify({ type: 'discard_thinking_text' }));
                    hasVisibleText = false;
                }
                const functionResponses = await Promise.all(
                    functionCalls.map(async (fnCall) => {
                        if (isCancelled()) {
                            return null;
                        }

                        const name = fnCall.name;
                        const args = catalogQueryContinuity.normalize(name, fnCall.args);
                        if (catalogIdentityResolved && ['searchProducts', 'listCategories'].includes(name)) {
                            const blocked = resolvedCatalogIdentityBlock();
                            return {
                                outcome: { name, query: String(args.query || ''), content: blocked },
                                error: '',
                                productPresentation: null,
                                functionResponse: { name, response: { content: blocked } }
                            };
                        }
                        const reservation = toolBudget.reserve(name, args);
                        if (!reservation.allowed) {
                            return {
                                outcome: {
                                    name,
                                    query: String(args.query || ''),
                                    content: {
                                        status: 'blocked',
                                        reason: reservation.reason,
                                        message: toolBudgetMessage(reservation.reason)
                                    }
                                },
                                error: '',
                                productPresentation: null,
                                functionResponse: {
                                    name,
                                    response: {
                                        content: {
                                            status: 'blocked',
                                            reason: reservation.reason,
                                            message: toolBudgetMessage(reservation.reason)
                                        }
                                    }
                                }
                            };
                        }
                        console.log(`[Gemini] AI Calling Tool: ${name}`, args);
                        const activityId = createToolActivityId(fnCall.id, name);
                        emitToolActivity(ws, {
                            activityId,
                            toolName: name,
                            state: 'running'
                        });
                        const content = await executeRegisteredMagentoTool(name, args, {
                            token: customerToken,
                            magentoOauth: config.magento_oauth,
                            runtime: options.runtime || null,
                            sessionCookie: options.sessionCookie || '',
                            requestBrowserCart: options.requestBrowserCart,
                            customerId: options.customerId || null,
                            guestOrderAccess: options.guestOrderAccess || null,
                            conversationId: options.conversationId || null,
                            shopperMessage: currentUserMessage.text || currentUserMessage.content || ''
                        });
                        if (requiresGuestOrderAccessForm(name, content)) {
                            ws.send(JSON.stringify({
                                type: 'guest_order_access_required',
                                state: 'email'
                            }));
                        }
                        if (options.requestOrderAddressForm === true) {
                            const addressForm = buildOrderAddressFormPayload(name, content, {
                                accessExpiresAt: options.guestOrderAccess?.expiresAt,
                                customerId: options.customerId,
                                sessionId: options.guestOrderAccess?.sessionId,
                                conversationId: options.conversationId
                            });
                            if (addressForm) {
                                ws.send(JSON.stringify(addressForm));
                            }
                        }
                        const customerAddressForm = buildCustomerAddressFormPayload(name, content, {
                            customerId: options.customerId,
                            conversationId: options.conversationId,
                            requestAddressForm: options.requestCustomerAddressForm === true
                        });
                        if (customerAddressForm) {
                            ws.send(JSON.stringify(customerAddressForm));
                        }
                        const toolFailed = Boolean(content?.error) || String(content?.status || '').toLowerCase() === 'error';
                        emitToolActivity(ws, {
                            activityId,
                            toolName: name,
                            state: toolFailed ? 'failed' : 'completed',
                            result: content
                        });
                        let catalogPresentation = null;
                        let productPresentation = null;
                        if (name === 'searchProducts') {
                            const presentation = createCatalogToolPresentation(content, args);
                            catalogPresentation = presentation.catalog;
                            productPresentation = presentation.event;
                        }
                        
                        // Prepare summary response for Gemini to avoid sending huge HTML strings
                        let aiResponseData = content;
                        if (name === 'searchProducts') {
                            const { items, pagination, scope } = catalogPresentation;
                            aiResponseData = content.error ? { error: content.error } : {
                                query: String(args.query || ''),
                                products_found: items.length,
                                total_products: pagination.total,
                                pagination,
                                category: scope,
                                products: items.map((item) => ({
                                    id: item.id,
                                    sku: item.sku,
                                    name: item.name,
                                    price: item.price,
                                    in_stock: item.in_stock,
                                    url: item.url,
                                    direct_addable: item.direct_addable === true,
                                    minimum_qty: item.minimum_qty,
                                    maximum_qty: item.maximum_qty,
                                    qty_increment: item.qty_increment,
                                    default_add_qty: item.default_add_qty,
                                    variant_options: item.variant_options
                                })),
                                response_language_instruction: responseLanguageInstruction(
                                    args.responseLanguage,
                                    args.responseLanguageEvidence,
                                    currentUserMessage.text || currentUserMessage.content || '',
                                    args.query
                                ),
                                instruction: scope.unavailable_query_match
                                    ? 'A close catalogue identity exists but is disabled. Stop retrieval. Do not browse a similar-sounding category and do not substitute another product. State that no currently available exact match was found.'
                                    : (items.length > 0
                                        ? `Only mention products returned in this page. direct_addable is Magento-validated: state that a product can be added immediately only when it is true. A default_add_qty above 1 must be stated as the minimum directly addable quantity, with qty_increment when relevant. When this search used directAddOnly, every returned product meets that requirement. ${catalogCoverageInstruction(pagination)} Do not invent products from later pages.`
                                        : 'No products matched this retrieval. Before concluding there is no match, inspect categories or retry a meaningfully different query/category when that can resolve the request.')
                            };
                        } else if (name === 'listCategories') {
                            const categories = Array.isArray(content.data) ? content.data : [];
                            aiResponseData = {
                                categories: categories
                                    .map((category) => ({
                                        id: Number(category?.id || 0),
                                        name: String(category?.name || ''),
                                        url: String(category?.url || ''),
                                        product_count: Number(category?.product_count || 0),
                                        parent_id: Number(category?.parent_id || 0),
                                        level: Number(category?.level || 0)
                                    }))
                                    .filter((category) => category.id > 0 && category.name)
                                    .slice(0, 200),
                                response_language_instruction: responseLanguageInstruction(
                                    args.responseLanguage,
                                    args.responseLanguageEvidence,
                                    currentUserMessage.text || currentUserMessage.content || '',
                                    args.query
                                ),
                                instruction: 'Only describe the exact returned Magento categories. A category count is not a list of products.'
                            };
                        } else if (name === 'getProductAvailability') {
                            aiResponseData = Array.isArray(content.data) && content.data[0]
                                ? content.data[0]
                                : { error: content.error || 'Availability could not be checked.' };
                        } else if ((name === 'addToCart' || name === 'removeFromCart') && !content?.error) {
                            const cartLabel = content?.cart_type === 'request_quote'
                                ? 'storefront Quote Cart (Anfrage-Zettel)'
                                : 'normal storefront shopping cart';
                            aiResponseData = {
                                ...content,
                                instruction: String(content?.status || '').toLowerCase() === 'success'
                                    ? (name === 'removeFromCart'
                                        ? `Confirm the exact product was removed from the ${cartLabel}. Do not claim the other cart changed.`
                                        : `Confirm the exact product, quantity, and selected options were added to the ${cartLabel}. Do not claim the other cart changed or that a different variant was added.`)
                                    : String(content?.reason || '').toLowerCase() === 'product_not_found_in_cart'
                                        ? `State that the product was not present in the ${cartLabel}; do not claim anything was removed.`
                                        : String(content?.reason || '').toLowerCase() === 'invalid_quantity'
                                            ? 'The product does not need product-page configuration. Explain the returned minimum, maximum, and increment rules. Ask for a valid quantity; do not claim the cart changed.'
                                        : 'This is a selection or product-page requirement, not an out-of-stock result. Do not say unavailable unless the returned reason is out_of_stock.'
                            };
                        } else if ((name === 'getCustomerAddresses' || name === 'updateCustomerAddress') && !content?.error) {
                            const status = String(content?.status || '').toLowerCase();
                            aiResponseData = {
                                ...content,
                                instruction: status === 'success'
                                    ? (name === 'getCustomerAddresses'
                                        ? (options.requestCustomerAddressForm === true
                                            ? 'The secure account-address form is already shown. Briefly tell the signed-in shopper they can edit their default billing and shipping addresses there.'
                                            : 'Summarize only the returned default billing and shipping addresses. The shopper asked to view them, so do not say that a form is open or invite form submission.')
                                        : 'Confirm only the returned default billing or shipping account address was updated.')
                                    : 'Explain that account addresses require sign-in or correct form values. Never expose or alter another customer’s address.'
                            };
                        } else if ([
                            'getRecentOrders',
                            'getGuestOrders',
                            'getGuestOrderDetails',
                            'getOrderDetails',
                            'updateGuestOrderAddress',
                            'updateOrderAddress'
                        ].includes(name) && !content?.error) {
                            const status = String(content?.status || '').toLowerCase();
                            aiResponseData = {
                                ...content,
                                instruction: status === 'success'
                                    ? (['updateOrderAddress', 'updateGuestOrderAddress'].includes(name)
                                        ? 'Confirm only the returned order number and address type were updated. Do not claim shipping, taxes, payment, or another order changed.'
                                        : 'Use only the returned order data. Do not expose another customer’s data or invent an order status.')
                                    : 'Explain the returned account, ownership, shipment, or missing-address limitation concisely. Do not reveal internal authorization details or guess another order.'
                            };
                        }

                        const outcome = {
                            name,
                            query: String(args.query || ''),
                            responseLanguage: String(args.responseLanguage || args.response_language || ''),
                            ...(name === 'searchProducts' ? {
                                catalogRequest: {
                                    exactIdentity: args.exactIdentity === true || args.exact_identity === true,
                                    categoryId: Math.max(0, Math.trunc(Number(args.categoryId || args.category_id) || 0)),
                                    minPrice: Number(args.minPrice || args.min_price) || 0,
                                    maxPrice: Number(args.maxPrice || args.max_price) || 0,
                                    directAddOnly: args.directAddOnly === true || args.direct_add_only === true
                                }
                            } : {}),
                            content
                        };
                        if (typeof options.onToolOutcome === 'function') {
                            options.onToolOutcome(outcome);
                        }

                        return {
                            outcome: {
                                ...outcome
                            },
                            error: toolFailed
                                ? String(content?.error || content?.message || 'The storefront cart request failed.')
                                : '',
                            productPresentation,
                            functionResponse: {
                                name,
                                response: { content: aiResponseData }
                            }
                        };
                    })
                );

                if (isCancelled()) {
                    return { cancelled: true };
                }

                const completedFunctionResponses = functionResponses.filter(Boolean);
                // Promise completion order is not a presentation contract.
                // Reconcile results in the original tool-call order returned
                // by Promise.all, retaining only the last successful search.
                completedFunctionResponses.forEach((result) => {
                    catalogQueryContinuity.observe(
                        result.outcome?.name,
                        { query: result.outcome?.query },
                        result.outcome?.content
                    );
                    lastToolOutcome = result.outcome;
                    if (isResolvedCatalogIdentity(result.outcome)) {
                        catalogIdentityResolved = true;
                    }
                    if (result.outcome?.name === 'searchProducts'
                        && !catalogIdentityResolved
                        && isTerminalCatalogMiss(result.outcome.content)) {
                        terminalCatalogMessage = unavailableCatalogMessage(result.outcome);
                        pendingProductPresentation = null;
                        hasVisibleProducts = false;
                    }
                    if (result.productPresentation && !terminalCatalogMessage) {
                        pendingProductPresentation = result.productPresentation;
                        hasVisibleProducts = true;
                    }
                    if (result.error) toolErrorMessage = result.error;
                });

                // Append provider-compatible function responses to history.
                chatHistory.push({
                    role: 'function',
                    parts: completedFunctionResponses.map(result => result.functionResponse)
                });

                if (toolErrorMessage) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        content: `Magento tool failed: ${toolErrorMessage}`
                    }));
                    break;
                }

                if (terminalCatalogMessage) {
                    await emitFinalText(ws, terminalCatalogMessage, isCancelled);
                    hasVisibleText = true;
                    isDone = true;
                }

            } else {
                const safeRemainingText = responseSanitizer.flush();
                if (safeRemainingText) {
                    hasVisibleText = true;
                    streamedTextThisTurn = true;
                    smoothEmitter.push(safeRemainingText);
                }
                await smoothEmitter.drain();
                isDone = true;
            }
        }

        if (!hasVisibleText) {
            if (isCancelled()) {
                return { cancelled: true };
            }

            await emitFinalText(
                ws,
                buildFallbackMessage(lastToolOutcome, hasVisibleProducts, preferredAddress),
                isCancelled
            );
        }

        if (isCancelled()) {
            return { cancelled: true };
        }

        emitProductPresentation(ws, pendingProductPresentation);
        ws.send(JSON.stringify({ type: 'done' }));
        return { cancelled: false };

    } catch (error) {
        if (options.signal?.aborted || error.name === 'AbortError' || /abort|aborted/i.test(error.message || '')) {
            return { cancelled: true };
        }

        console.error('Gemini Orchestrator Error:', summarizeError(error));
        ws.send(JSON.stringify({ type: 'error', content: formatGeminiError(error) }));
        return { cancelled: false, error };
    }
};

function formatGeminiError(error) {
    const message = String(error?.message || '');
    if (error?.status === 429 || /quota|too many requests|rate[- ]?limit/i.test(message)) {
        return 'The AI provider is temporarily rate limited. Please try again in a moment.';
    }

    if (error?.status === 401 || error?.status === 403 || /api key|permission|unauthorized|forbidden/i.test(message)) {
        return 'The AI provider credentials are not valid. Please check the AI configuration.';
    }

    if (/invalid image|image data.*valid image|does not represent a valid image|corrupt image|malformed image/i.test(message)) {
        return 'Ảnh không hợp lệ hoặc không đọc được. Hãy thử ảnh JPG, PNG hoặc WebP khác.';
    }

    if (/image|vision|multimodal|inline_data|unsupported.*image/i.test(message)) {
        return 'Mô hình AI hiện tại chưa hỗ trợ ảnh. Hãy đổi sang model có vision hoặc kiểm tra lại provider.';
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

function requiresGuestOrderAccessForm(name, content) {
    if (!['getGuestOrders', 'getGuestOrderDetails', 'updateGuestOrderAddress'].includes(name)) {
        return false;
    }

    return ['guest_access_required', 'guest_reverification_required']
        .includes(String(content?.reason || '').toLowerCase());
}

function buildFallbackMessage(lastToolOutcome, hasVisibleProducts, preferredAddress = '') {
    let message;

    if (hasVisibleProducts) {
        const products = Array.isArray(lastToolOutcome?.content?.data) ? lastToolOutcome.content.data : [];
        const count = products.length;
        if (count > 0) {
            const names = products
                .slice(0, 2)
                .map((item) => String(item?.name || '').trim())
                .filter(Boolean);
            const examples = names.length > 0 ? `, ví dụ ${names.join(' và ')}` : '';
            message = `Mình tìm được ${count} sản phẩm phù hợp${examples}. Bạn có thể chọn một sản phẩm bên dưới hoặc nói thêm tiêu chí để mình lọc tiếp.`;
            return applyPreferredAddress(message, preferredAddress);
        }

        message = 'Mình tìm được sản phẩm phù hợp. Bạn có thể chọn một sản phẩm bên dưới hoặc nói thêm tiêu chí để mình lọc tiếp.';
        return applyPreferredAddress(message, preferredAddress);
    }

    if (lastToolOutcome?.name === 'searchProducts') {
        const products = Array.isArray(lastToolOutcome.content?.data) ? lastToolOutcome.content.data : [];
        if (products.length === 0) {
            message = 'Mình chưa tìm thấy sản phẩm khớp chính xác với yêu cầu này. Bạn có thể cho mình thêm category, màu, size, brand hoặc mức giá để mình lọc chính xác hơn.';
            return applyPreferredAddress(message, preferredAddress);
        }
    }

    if (lastToolOutcome?.name === 'listCategories') {
        const categories = Array.isArray(lastToolOutcome.content?.data) ? lastToolOutcome.content.data : [];
        if (categories.length > 0) {
            message = 'Mình đã lấy danh mục sản phẩm của cửa hàng. Bạn có thể nói rõ nhóm bạn muốn xem, ví dụ áo thun, quà tặng hoặc đồ mùa hè.';
            return applyPreferredAddress(message, preferredAddress);
        }
    }

    message = 'Mình đã xử lý yêu cầu nhưng chưa tạo được câu trả lời phù hợp. Bạn thử mô tả cụ thể hơn để mình tìm chính xác hơn nhé.';
    return applyPreferredAddress(message, preferredAddress);
}

function extractPreferredAddress(history = []) {
    if (!Array.isArray(history) || history.length === 0) return '';

    const text = history
        .map((message) => {
            if (Array.isArray(message?.parts)) {
                return message.parts.map((part) => part?.text || part?.raw || '').join('\n');
            }
            return String(message?.content || message?.text || '');
        })
        .join('\n')
        .slice(-6000);

    const normalized = normalizeVietnameseText(text);
    const patterns = [
        /\b(?:hay\s+)?goi\s+(?:toi|minh|tui|to|em|anh|chi|tao)\s+la\s+([a-z0-9 _-]{1,40})/i,
        /\bcall\s+me\s+([a-z0-9 _-]{1,40})/i
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (!match?.[1]) continue;

        const address = match[1]
            .replace(/\b(duoc chu|duoc khong|duoc|khong|nhe|nha|please|ok|okay|from now on|tu gio)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (address) {
            if (address === 'dai ca') return 'đại ca';
            return address.slice(0, 40);
        }
    }

    return '';
}

function applyPreferredAddress(message, preferredAddress = '') {
    const address = String(preferredAddress || '').trim();
    if (!address) return message;

    const label = address.charAt(0).toUpperCase() + address.slice(1);
    if (normalizeVietnameseText(message).startsWith(`${normalizeVietnameseText(address)},`)) {
        return message;
    }

    return `${label}, ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
}

function normalizeVietnameseText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9 _\-\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Calls Magento REST APIs
 */
