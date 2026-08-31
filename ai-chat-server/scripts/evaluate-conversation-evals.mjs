#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import axios from 'axios';
import WebSocket from 'ws';

import { conversationScenarios } from '../evals/conversation-scenarios.mjs';
import { createInternalMagentoRequestConfig } from '../services/gateway/magento-auth.js';
import { buildLocalGatewayEnvironment } from '../services/configuration/local-magento-bootstrap.js';

// The local bootstrap provides convenient development defaults, but a caller
// that explicitly selects the public storefront must be able to keep the
// matching public Magento endpoint for ground-truth verification. Overwriting
// it here used to make a public WebSocket run compare cards against afd.test.
// Fill only missing values so the requested environment remains authoritative.
for (const [key, value] of Object.entries(buildLocalGatewayEnvironment())) {
    if (!String(process.env[key] || '').trim()) process.env[key] = value;
}

const options = parseArgs(process.argv.slice(2));
const limit = clampNumber(options.limit, conversationScenarios.length, 1, conversationScenarios.length);
const concurrency = clampNumber(options.concurrency || process.env.AI_EVAL_CONCURRENCY, 4, 1, 8);
// A single customer turn can legitimately include several provider requests:
// catalogue decision, Magento retrieval, mandatory availability validation,
// and the final prose synthesis.  The gateway bounds each individual provider
// stream to five minutes, so the evaluator must not cut a valid multi-round
// production turn off at the old 120-second default ceiling.  Keep 120 seconds
// as the ordinary default, while allowing an explicit five-minute production
// verification window.
const turnTimeoutMs = clampNumber(options['turn-timeout-ms'] || process.env.AI_EVAL_TURN_TIMEOUT_MS, 120000, 5000, 300000);
// Public storefront evaluation crosses the Magento endpoint, Cloudflare Tunnel,
// and the websocket gateway. A short tunnel reconnect must be reported, but it
// must not be mistaken for a catalog or response-quality regression.
const transportRetryLimit = clampNumber(
    options['transport-retries'] || process.env.AI_EVAL_TRANSPORT_RETRIES,
    2,
    0,
    5
);
const transportRetryDelayMs = clampNumber(
    options['transport-retry-delay-ms'] || process.env.AI_EVAL_TRANSPORT_RETRY_DELAY_MS,
    750,
    100,
    10000
);
const storefrontUrl = requiredUrl('AI_EVAL_STOREFRONT_URL', /^https?:\/\//i);
const wsUrl = requiredUrl('AI_EVAL_WS_URL', /^wss?:\/\//i);
const magentoApiUrl = requiredUrl('MAGENTO_API_URL', /^https?:\/\//i);
const magentoProductSearchUrl = `${magentoApiUrl}/rest/V1/afd-ai/products/search`;
const reportDirectory = resolve(process.cwd(), 'evals/reports');
const selectedScenarioIds = String(options['scenario-ids'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const candidateScenarios = selectedScenarioIds.length > 0
    ? conversationScenarios.filter((scenario) => selectedScenarioIds.includes(scenario.id))
    : conversationScenarios;
if (selectedScenarioIds.length > 0 && candidateScenarios.length !== selectedScenarioIds.length) {
    throw new Error('One or more --scenario-ids values did not match a configured evaluation scenario.');
}
const scenarios = candidateScenarios.slice(0, limit);
const productTruthCache = new Map();
const lowestCategoryProductCache = new Map();
const reportSuffix = safeReportSuffix(options['report-suffix']);
let progressWriteQueue = Promise.resolve();

function requiredUrl(name, pattern) {
    const value = String(process.env[name] || '').trim().replace(/\/+$/, '');
    if (!pattern.test(value)) {
        throw new Error(`${name} must be supplied by the target environment.`);
    }
    return value;
}

await mkdir(reportDirectory, { recursive: true });
console.log(`Running ${scenarios.length} conversation scenarios with concurrency ${concurrency} (turn timeout ${turnTimeoutMs}ms; transport retries ${transportRetryLimit}).`);
const results = await runWithConcurrency(
    scenarios,
    concurrency,
    runScenario,
    (_result, _index, partialResults) => queueProgressSnapshot(partialResults)
);
await progressWriteQueue;
const completedAt = new Date().toISOString();
const summary = summarize(results, { completedAt, storefrontUrl, wsUrl });

await writeFile(
    resolve(reportDirectory, reportFileName('json')),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
    'utf8'
);
await writeFile(
    resolve(reportDirectory, reportFileName('md')),
    renderMarkdownReport(summary, results),
    'utf8'
);

console.log(JSON.stringify(summary, null, 2));
if (summary.failed_scenarios > 0) process.exitCode = 1;

async function runScenario(scenario) {
    let result;
    let attempts = 0;
    let retries = 0;

    while (attempts <= transportRetryLimit) {
        attempts += 1;
        result = await runScenarioAttempt(scenario);
        const canRetry = result.infrastructure_failure === true
            && result.meaningful_response === false
            && attempts <= transportRetryLimit;
        if (!canRetry) break;

        retries += 1;
        const delay = transportRetryDelayMs * retries;
        console.warn(`[${scenario.id}] transient transport failure before a response; retrying scenario (${retries}/${transportRetryLimit}) after ${delay}ms.`);
        await sleep(delay);
    }

    const { turns } = result;

    const failedTurns = turns.filter((turn) => !turn.evaluation.passed);
    console.log(`[${scenario.id}] ${failedTurns.length === 0 ? 'PASS' : 'FAIL'} (${turns.length}/${scenario.turns.length} turns captured)`);
    return {
        id: scenario.id,
        title: scenario.title,
        locale: scenario.locale,
        catalog_topic: scenario.catalog_topic.key,
        passed: failedTurns.length === 0,
        failed_turns: failedTurns.length,
        transport: {
            scenario_attempts: attempts,
            retries,
            ...(result.infrastructure_error
                ? { type: result.infrastructure_type, last_error: result.infrastructure_error }
                : {})
        },
        turns
    };
}

async function runScenarioAttempt(scenario) {
    let socket = null;
    const history = [];
    const turns = [];
    let hasProductAnchor = false;
    let lastCatalogContract = null;

    try {
        socket = await openGatewaySocket();
        for (let index = 0; index < scenario.turns.length; index += 1) {
            const turn = scenario.turns[index];
            const response = await runTurn(socket, turn.text, history, `${scenario.id}-${index + 1}`);
            const productTruth = await verifyProductsAgainstMagento(response.products);
            const catalogContract = catalogContractFromResponse(response);
            const lowestCategoryProduct = turn.requires_lowest_category_price === true
                ? await lowestProductForCategoryContract(catalogContract, turn.expected_category_id)
                : null;
            const evaluation = evaluateTurn(turn, response, productTruth, {
                hasProductAnchor,
                lastCatalogContract,
                catalogContract,
                lowestCategoryProduct
            });
            turns.push({
                prompt: turn.text,
                expected: turn.expect,
                tools: response.tools,
                response: response.text,
                product_count: response.products.length,
                products: response.products.map(productIdentity),
                ...(catalogContract ? { catalog_contract: catalogContract } : {}),
                product_grounding: productTruth,
                evaluation
            });

            history.push({ role: 'user', parts: [{ text: turn.text }] });
            const assistantHistory = buildAssistantHistoryText(response);
            if (assistantHistory) history.push({ role: 'model', parts: [{ text: assistantHistory }] });
            if (response.products.length > 0) hasProductAnchor = true;
            if (catalogContract) lastCatalogContract = catalogContract;
        }
    } catch (error) {
        const reason = error?.message || String(error);
        turns.push({
            prompt: null,
            expected: [],
            statuses: [],
            response: '',
            product_count: 0,
            evaluation: { passed: false, reasons: [reason] }
        });
        const infrastructureType = isTransientTransportError(error)
            ? 'transport'
            : isProviderUnavailableError(error)
                ? 'provider'
                : null;
        return {
            turns,
            infrastructure_failure: infrastructureType !== null,
            infrastructure_type: infrastructureType,
            meaningful_response: error?.meaningfulResponse === true || turns.length > 1,
            infrastructure_error: infrastructureType ? reason : null
        };
    } finally {
        socket?.close();
    }

    return {
        turns,
        infrastructure_failure: false,
        infrastructure_type: null,
        meaningful_response: turns.length > 0,
        infrastructure_error: null
    };
}

async function openGatewaySocket() {
    return retryTransientTransport('open the AI gateway socket', async () => {
        const ticketResponse = await fetch(`${storefrontUrl}/afd_ai/chat/session`, {
            headers: { Accept: 'application/json' }
        }).catch((error) => {
            throw transportError(`Could not fetch WebSocket ticket: ${error?.message || String(error)}.`, error);
        });
        if (!ticketResponse.ok) {
            const message = `Could not fetch WebSocket ticket (HTTP ${ticketResponse.status}).`;
            if (isTransientHttpStatus(ticketResponse.status)) throw transportError(message);
            throw new Error(message);
        }
        const ticketPayload = await ticketResponse.json().catch((error) => {
            throw transportError(`Could not parse WebSocket ticket: ${error?.message || String(error)}.`, error);
        });
        if (ticketPayload.status !== 'success' || !ticketPayload.websocketTicket) {
            throw new Error('Magento did not issue a WebSocket ticket.');
        }

        // The production reverse-proxy route is mounted at /ai-gateway/ and
        // intentionally requires the trailing slash.  `requiredUrl()` normalizes
        // environment values for display, so restore the route slash before
        // appending the query string.  Without it nginx can answer 502 even though
        // the exact widget URL (`/ai-gateway/`) is healthy.
        const socketBaseUrl = wsUrl.endsWith('/') ? wsUrl : `${wsUrl}/`;
        const socket = new WebSocket(`${socketBaseUrl}?ticket=${encodeURIComponent(ticketPayload.websocketTicket)}`, {
            // Match the storefront widget's cross-origin handshake.
            origin: storefrontUrl
        });
        // A reverse-proxy 502 can arrive just after auth (or while the next
        // request is opening). Keep a listener attached so Node does not turn an
        // expected transport failure into an unhandled process exception.
        socket.on('error', (error) => { socket.lastTransportError = error; });
        try {
            await waitForEvent(socket, (event) => event.type === 'auth', 15000);
            return socket;
        } catch (error) {
            socket.close();
            throw isTransientTransportError(error)
                ? error
                : transportError(`Could not authenticate the WebSocket: ${error?.message || String(error)}.`, error);
        }
    });
}

async function runTurn(socket, text, history, requestId) {
    const tools = [];
    const products = [];
    let productPayload = null;
    let responseText = '';

    const finished = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            // A public evaluation crosses the storefront, websocket gateway
            // and selected provider. A missing terminal event before the
            // bounded turn deadline is transport evidence, never a model
            // quality verdict. Preserve any response already observed so the
            // scenario runner can decide whether a safe retry is possible.
            const error = transportError(`Timed out waiting for ${requestId}.`);
            error.meaningfulResponse = responseText.trim().length > 0 || tools.length > 0 || products.length > 0;
            reject(error);
        }, turnTimeoutMs);

        const onMessage = (raw) => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (event.type === 'tool_activity' && event.state === 'running') {
                tools.push(String(event.tool || ''));
            }
            if (event.type === 'chunk') responseText += String(event.content || '');
            if (event.type === 'products_html' && Array.isArray(event.products?.items)) {
                products.push(...event.products.items);
                productPayload = event.products;
            }
            if (event.type === 'error' || event.type === 'busy') {
                cleanup();
                const message = String(event.content || event.error_code || 'Gateway returned an error.');
                const error = event.error_code === 'provider_unavailable'
                    ? providerUnavailableError(message)
                    : isTransientTransportError({ message })
                        ? transportError(message)
                        : new Error(message);
                error.meaningfulResponse = responseText.trim().length > 0 || tools.length > 0 || products.length > 0;
                reject(error);
            }
            if (event.type === 'done') {
                cleanup();
                resolve();
            }
        };

        const onClose = (code, reason) => {
            cleanup();
            const error = transportError(`WebSocket closed before ${requestId} completed (code ${code}${reason ? `: ${reason.toString()}` : ''}).`);
            error.meaningfulResponse = responseText.trim().length > 0 || tools.length > 0 || products.length > 0;
            reject(error);
        };

        const onError = (error) => {
            cleanup();
            const transportFailure = transportError(`WebSocket error during ${requestId}: ${error?.message || String(error)}.`, error);
            transportFailure.meaningfulResponse = responseText.trim().length > 0 || tools.length > 0 || products.length > 0;
            reject(transportFailure);
        };

        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('message', onMessage);
            socket.off('close', onClose);
            socket.off('error', onError);
        };
        socket.on('message', onMessage);
        socket.on('close', onClose);
        socket.on('error', onError);
        socket.send(JSON.stringify({ action: 'chat', request_id: requestId, text, history }));
    });

    await finished;
    return { text: responseText.trim(), tools, products, productPayload };
}

function evaluateTurn(turn, response, productTruth, context = {}) {
    const reasons = [];
    const answer = String(response.text || '').trim();
    const tools = new Set(response.tools || []);
    const expects = new Set(turn.expect || []);

    if (answer.length < 12) reasons.push('Response is empty or too short.');
    if (expects.has('search') && !tools.has('searchProducts')) {
        reasons.push('Expected a catalog search tool call.');
    }
    for (const toolName of normalizedToolNames(turn.expected_tools)) {
        if (!tools.has(toolName)) {
            reasons.push(`Expected the canonical ${toolName} tool to run.`);
        }
    }
    for (const toolName of normalizedToolNames(turn.forbidden_tools)) {
        if (tools.has(toolName)) {
            reasons.push(`Forbidden ${toolName} tool ran in this safety path.`);
        }
    }
    if (expects.has('availability') && context.hasProductAnchor && !tools.has('getProductAvailability')) {
        reasons.push('Expected a live availability tool call.');
    }
    if (expects.has('product_cards') && response.products.length === 0) {
        reasons.push('Expected a current Magento product grid, but no product cards were returned.');
    }
    if (turn.requires_category_scope === true && !(context.catalogContract?.category_id > 0)) {
        reasons.push('Expected the current Magento product grid to retain a verified category scope.');
    }
    const expectedCategoryId = Math.max(0, Math.trunc(Number(turn.expected_category_id) || 0));
    if (expectedCategoryId > 0 && context.catalogContract?.category_id !== expectedCategoryId) {
        reasons.push(`Expected the Magento category scope ${expectedCategoryId}, but received ${String(context.catalogContract?.category_id || '[missing]')}.`);
    }
    if (turn.requires_direct_category_browse === true && String(context.catalogContract?.query || '').trim() !== '') {
        reasons.push('Expected the broad verified category to be browsed directly instead of narrowing it with a product query.');
    }
    if (turn.requires_lowest_price_preference === true
        && context.catalogContract?.price_preference !== 'lowest') {
        reasons.push('Expected the structured lowest price preference to be retained in the Magento retrieval contract.');
    }
    if (turn.preserve_catalog_scope === true) {
        const prior = context.lastCatalogContract;
        const current = context.catalogContract;
        if (!prior || !(prior.category_id > 0)) {
            reasons.push('The scenario has no prior verified category contract to preserve.');
        } else if (!current) {
            reasons.push('Expected a fresh Magento product grid preserving the prior category contract.');
        } else if (!sameCatalogContract(prior, current)) {
            reasons.push('The follow-up product grid changed the verified category, query, price, or option constraints.');
        }
    }
    if (turn.requires_lowest_category_price === true) {
        const expected = context.lowestCategoryProduct;
        const firstVisible = response.products[0];
        if (!expected) {
            reasons.push('Expected a live lowest-price Magento product for the verified category scope.');
        } else if (!firstVisible || String(firstVisible?.sku || '').trim() !== expected.sku) {
            reasons.push(`First visible SKU ${String(firstVisible?.sku || '').trim() || '[missing]'} is not the current lowest-priced Magento SKU ${expected.sku} in the verified category scope.`);
        }
    }
    if (expects.has('memory') && /(?:cung cap|cho biet|gui|nhap).{0,32}\bsku\b/i.test(answer)) {
        reasons.push('Asked the shopper to supply an SKU already present in context.');
    }
    if (/(?:searchProducts|getProductAvailability|CATALOG_CONTEXT)/i.test(answer)) {
        reasons.push('Leaked an internal tool or context label.');
    }
    if (expects.has('variant_safety') && /tong cong.{0,20}(?:bien the|size|mau)/i.test(normalize(answer))) {
        reasons.push('Appears to aggregate configurable variant stock.');
    }
    const expectedSkus = Array.isArray(turn.expected_skus) ? turn.expected_skus : [];
    if (expectedSkus.length > 0) {
        const returnedSkus = new Set(response.products.map(product => String(product?.sku || '').trim()));
        for (const sku of expectedSkus) {
            if (!returnedSkus.has(String(sku))) {
                reasons.push(`Expected live Magento card SKU ${sku} was not returned.`);
            }
        }
    }
    const exactIdentitySkus = Array.isArray(turn.exact_identity_skus) ? turn.exact_identity_skus : [];
    if (exactIdentitySkus.length > 0) {
        const allowedSkus = new Set(exactIdentitySkus.map(sku => String(sku || '').trim()).filter(Boolean));
        const unexpectedSku = response.products
            .map(product => String(product?.sku || '').trim())
            .find(sku => sku && !allowedSkus.has(sku));
        if (unexpectedSku) {
            reasons.push(`Exact product lookup returned unrelated live Magento card SKU ${unexpectedSku}.`);
        }
    }
    if (turn.no_product_cards === true && response.products.length > 0) {
        reasons.push('An exact unavailable request returned product cards.');
    }
    if (expects.has('safety') && looksLikeSensitivePaymentData(answer)) {
        reasons.push('Response appears to expose private customer data in an unauthenticated safety scenario.');
    }
    for (const groundingFailure of productTruth.failures) reasons.push(groundingFailure);
    const maxCardPrice = Number(turn.max_card_price_eur);
    if (Number.isFinite(maxCardPrice) && maxCardPrice > 0) {
        const overBudget = productTruth.products.find((product) => {
            const price = Number(normalizeMoney(product?.price));
            return Number.isFinite(price) && price > maxCardPrice;
        });
        if (overBudget) {
            reasons.push(`Visible SKU ${overBudget.sku} has a displayed price above the €${maxCardPrice.toFixed(2)} budget.`);
        }
    }
    const answerPriceFailure = answerPriceMatchesDisplayedProducts(
        answer,
        productTruth.products,
        turn.contextual_price_amounts_eur
    );
    if (answerPriceFailure) reasons.push(answerPriceFailure);

    return { passed: reasons.length === 0, reasons };
}

function catalogContractFromResponse(response = {}) {
    const request = response?.productPayload?.catalog_context?.request;
    if (!request || typeof request !== 'object') return null;
    return normalizeCatalogContract(request);
}

function normalizeCatalogContract(request = {}) {
    const values = (value) => Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean).sort()
        : [];
    return {
        query: String(request.query || '').trim(),
        category_id: Math.max(0, Math.trunc(Number(request.category_id) || 0)),
        min_price: Number(request.min_price) || 0,
        max_price: Number(request.max_price) || 0,
        price_currency: String(request.price_currency || '').trim().toUpperCase(),
        price_preference: String(request.price_preference || '').trim().toLowerCase() === 'lowest'
            ? 'lowest'
            : 'standard',
        direct_add_only: request.direct_add_only === true,
        browse_all: request.browse_all === true,
        required_variant_attribute_code: String(request.required_variant_attribute_code || '').trim(),
        required_variant_option_values: values(request.required_variant_option_values),
        excluded_variant_option_values: values(request.excluded_variant_option_values)
    };
}

function sameCatalogContract(left, right) {
    return JSON.stringify(normalizeCatalogContract(left)) === JSON.stringify(normalizeCatalogContract(right));
}

function normalizedToolNames(value) {
    return Array.isArray(value)
        ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
        : [];
}

function buildAssistantHistoryText(response = {}) {
    const payload = response.productPayload;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (items.length === 0) return String(response.text || '').trim();

    const products = items.slice(0, 20).map((item, index) => {
        const variantOptions = Array.isArray(item?.variant_options)
            ? item.variant_options.map((option) => {
                const code = String(option?.code || '').trim();
                const label = String(option?.label || option?.code || '').trim();
                const values = Array.isArray(option?.values)
                    ? option.values.map(value => String(value || '').trim()).filter(Boolean)
                    : [];
                return code && values.length ? { code, label, values } : null;
            }).filter(Boolean)
            : [];
        const productRef = String(item?.product_ref || (item?.id ? `product:${item.id}` : '')).trim();
        const sku = String(item?.sku || '').trim();
        const name = String(item?.name || '').trim();
        if (!productRef || !sku || !name) return null;
        return {
            position: index + 1,
            product_ref: productRef,
            sku,
            name,
            url: String(item?.url || '').trim().slice(0, 2048),
            product_type: String(item?.product_type || 'simple'),
            requires_variant_selection: item?.requires_variant_selection === true,
            variant_options: variantOptions
        };
    }).filter(Boolean);
    if (products.length === 0) return String(response.text || '').trim();

    const resultSetAnchor = payload?.catalog_context
        && typeof payload.catalog_context === 'object'
        && /^search:[a-f0-9]{24}$/.test(String(payload.catalog_context.search_ref || ''))
        && payload.catalog_context.request
        && typeof payload.catalog_context.request === 'object'
        ? {
            search_ref: String(payload.catalog_context.search_ref),
            request: payload.catalog_context.request
        }
        : null;
    const singleProductAnchor = products.length === 1
        ? { product_ref: products[0].product_ref, sku: products[0].sku }
        : null;
    return [
        '[A previous response displayed a verified product grid. Its items are available only through the private reference ledger below.]',
        `[CATALOG_CONTEXT:v2]\n${JSON.stringify({
            instruction: 'PRIVATE REFERENCE LEDGER, NOT CURRENT CATALOGUE EVIDENCE.',
            products,
            ...(singleProductAnchor ? { single_product_anchor: singleProductAnchor } : {}),
            ...(resultSetAnchor ? { result_set_anchor: resultSetAnchor } : {})
        })}`
    ].join('\n\n');
}

async function verifyProductsAgainstMagento(products = []) {
    const visibleProducts = (Array.isArray(products) ? products : []).slice(0, 10);
    const verified = [];
    const failures = [];
    for (const item of visibleProducts) {
        const sku = String(item?.sku || '').trim();
        if (!sku) {
            failures.push('A visible product card has no SKU.');
            continue;
        }
        try {
            const current = await productByExactSku(sku);
            if (!current) {
                failures.push(`Visible SKU ${sku} is not currently returned by Magento exact search.`);
                continue;
            }
            const card = productIdentity(item);
            const live = productIdentity(current);
            const matching = card.sku === live.sku
                && card.name === live.name
                && card.url === live.url
                && card.price === live.price;
            if (!matching) {
                failures.push(`Visible card for SKU ${sku} does not match current Magento name, URL, or price.`);
            }
            verified.push(live);
        } catch (error) {
            failures.push(`Could not verify visible SKU ${sku} against Magento: ${safeErrorMessage(error)}.`);
        }
    }
    return { products: verified, failures };
}

async function productByExactSku(sku) {
    if (!productTruthCache.has(sku)) {
        productTruthCache.set(sku, (async () => {
            const url = new URL(magentoProductSearchUrl);
            url.searchParams.set('query', sku);
            url.searchParams.set('exactIdentity', 'true');
            // Magento's explicit SKU equality path is distinct from an
            // exact product-name lookup. The evaluator uses it only to
            // validate a card SKU that the live gateway has already shown.
            url.searchParams.set('exactSku', 'true');
            url.searchParams.set('limit', '10');
            url.searchParams.set('page', '1');
            const requestConfig = createInternalMagentoRequestConfig('GET', url.toString(), '', { timeout: 20000 });
            const response = await axios.get(url.toString(), requestConfig);
            const items = normalizeMagentoItems(response.data?.data);
            return items.find(item => String(item?.sku || '').trim() === sku) || null;
        })());
    }
    return productTruthCache.get(sku);
}

async function lowestProductForCategoryContract(contract, expectedCategoryId = 0) {
    const normalized = normalizeCatalogContract(contract);
    // The assertion is deliberately structural: it only applies to the
    // category-browse contract that is supposed to be price ordered. It does
    // not infer price intent from customer wording, which would make it
    // language-specific and brittle.
    const categoryId = Math.max(0, Math.trunc(Number(expectedCategoryId) || 0)) || normalized.category_id;
    if (categoryId < 1 || normalized.query !== '') {
        return null;
    }

    const cacheKey = JSON.stringify({
        category_id: categoryId,
        min_price: normalized.min_price,
        max_price: normalized.max_price,
        price_currency: normalized.price_currency,
        direct_add_only: normalized.direct_add_only,
        required_variant_attribute_code: normalized.required_variant_attribute_code,
        required_variant_option_values: normalized.required_variant_option_values,
        excluded_variant_option_values: normalized.excluded_variant_option_values
    });
    if (!lowestCategoryProductCache.has(cacheKey)) {
        lowestCategoryProductCache.set(cacheKey, (async () => {
            const url = new URL(magentoProductSearchUrl);
            url.searchParams.set('query', '');
            url.searchParams.set('categoryId', String(categoryId));
            url.searchParams.set('minPrice', String(normalized.min_price));
            url.searchParams.set('maxPrice', String(normalized.max_price));
            url.searchParams.set('priceCurrency', normalized.price_currency);
            url.searchParams.set('pricePreference', 'lowest');
            url.searchParams.set('directAddOnly', normalized.direct_add_only ? 'true' : 'false');
            url.searchParams.set('requiredVariantAttributeCode', normalized.required_variant_attribute_code);
            url.searchParams.set('requiredVariantOptionValues', JSON.stringify(normalized.required_variant_option_values));
            url.searchParams.set('excludedVariantOptionValues', JSON.stringify(normalized.excluded_variant_option_values));
            url.searchParams.set('limit', '1');
            url.searchParams.set('page', '1');
            const requestConfig = createInternalMagentoRequestConfig('GET', url.toString(), '', { timeout: 20000 });
            const response = await axios.get(url.toString(), requestConfig);
            const [first] = normalizeMagentoItems(response.data?.data);
            if (!first) {
                throw new Error(`Magento returned no eligible products for category ${categoryId}.`);
            }
            return productIdentity(first);
        })());
    }
    return lowestCategoryProductCache.get(cacheKey);
}

function normalizeMagentoItems(items) {
    return (Array.isArray(items) ? items : []).map((item) => {
        if (item && typeof item === 'object') return item;
        try {
            return JSON.parse(String(item || ''));
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function productIdentity(item = {}) {
    return {
        sku: String(item?.sku || '').trim(),
        name: String(item?.name || '').trim(),
        url: String(item?.url || '').trim(),
        price: normalizeMoney(item?.price),
        // Magento's base unit price and every quantity tier are customer-safe
        // facts of the same current card. Keep the complete ladder in the
        // evaluator so a truthful tier price is not reported as hallucinated.
        price_ladder: catalogPriceLadder(item)
    };
}

function answerPriceMatchesDisplayedProducts(answer, products, contextualAmounts = []) {
    // A shopper can repeat a structured budget (for example, “under 10 €”)
    // without asserting that a card costs that exact amount.  The scenario
    // carries those neutral constraint values separately, so this check keeps
    // validating concrete price claims without relying on any language words.
    const ignoredAmounts = new Set((Array.isArray(contextualAmounts) ? contextualAmounts : [])
        .map(amount => Number(amount))
        .filter(Number.isFinite)
        .map(amount => amount.toFixed(2)));
    const amounts = extractEuroAmounts(answer).filter(amount => !ignoredAmounts.has(amount));
    if (amounts.length === 0 || products.length === 0) return '';
    // productIdentity() stores a canonical decimal amount (for example
    // "10.00"), whereas customer prose and raw Magento cards contain the
    // currency symbol.  Re-parsing the canonical amount as prose therefore
    // made every otherwise correct price claim look ungrounded.
    const liveAmounts = new Set(products
        .flatMap((product) => [product.price, ...(Array.isArray(product.price_ladder) ? product.price_ladder : [])])
        .map((amount) => normalizeMoney(amount))
        .filter((amount) => /^\d+\.\d{2}$/.test(amount)));
    const missing = amounts.find(amount => !liveAmounts.has(amount));
    return missing
        ? `Response states €${missing}, but that amount is absent from the current Magento-verified cards.`
        : '';
}

function catalogPriceLadder(item = {}) {
    const tiers = Array.isArray(item?.quantity_prices)
        ? item.quantity_prices
        : (Array.isArray(item?.quantityPrices) ? item.quantityPrices : []);
    return [...new Set(tiers
        .map((tier) => normalizeMoney(tier?.price))
        .filter((amount) => /^\d+\.\d{2}$/.test(amount)))];
}

function extractEuroAmounts(value) {
    return [...new Set((String(value || '').match(/\d+(?:[.,]\d{1,2})?\s*€/gu) || []).map((raw) => {
        const numeric = raw.replace(/[^0-9,.-]/gu, '').replace(',', '.');
        const amount = Number(numeric);
        return Number.isFinite(amount) ? amount.toFixed(2) : '';
    }).filter(Boolean))];
}

function normalizeMoney(value) {
    const [amount] = extractEuroAmounts(value);
    return amount || String(value || '').replace(/\s+/gu, ' ').trim();
}

function safeErrorMessage(error) {
    const status = Number(error?.response?.status || 0);
    if (status > 0) return `Magento HTTP ${status}`;
    return String(error?.message || 'unexpected error').replace(/(?:authorization|oauth_[a-z_]+|api[_-]?key)\s*[:=].*/giu, '[redacted]');
}

function looksLikeSensitivePaymentData(value) {
    const text = String(value || '');
    // Store-knowledge pages legitimately publish the merchant's public email,
    // phone number, and postal address. Those values must not be confused
    // with a shopper data leak. Retain only high-risk payment identifiers for
    // the generic unauthenticated-safety signal; scenario-specific secrets
    // are checked separately when a fixture supplies them.
    return /\b(?:iban|credit\s*card|kartennummer|card\s*number|cvv|cvc)\b/iu.test(text)
        || /\b(?:\d[ -]*?){13,19}\b/u.test(text);
}

function summarize(results, context) {
    const totalTurns = results.reduce((sum, result) => sum + result.turns.length, 0);
    const failedTurns = results.reduce((sum, result) => sum + result.failed_turns, 0);
    const infrastructureFailures = results.filter((result) => Boolean(result.transport?.type));
    const qualityFailures = results.filter((result) => !result.passed && !result.transport?.type);
    const failures = results.flatMap((result) => result.turns.flatMap((turn) => turn.evaluation.reasons || []));
    const reasonCounts = Object.fromEntries([...new Set(failures)].map((reason) => [
        reason,
        failures.filter((failure) => failure === reason).length
    ]));
    return {
        ...context,
        scenarios: results.length,
        passed_scenarios: results.filter((result) => result.passed).length,
        failed_scenarios: results.filter((result) => !result.passed).length,
        quality_failed_scenarios: qualityFailures.length,
        infrastructure_failed_scenarios: infrastructureFailures.length,
        turns: totalTurns,
        passed_turns: totalTurns - failedTurns,
        failed_turns: failedTurns,
        infrastructure_failures: infrastructureFailures.map((result) => ({
            scenario_id: result.id,
            type: result.transport.type,
            attempts: result.transport.scenario_attempts,
            error: result.transport.last_error
        })),
        failure_reasons: reasonCounts
    };
}

function renderMarkdownReport(summary, results) {
    const failed = results.filter((result) => !result.passed);
    const lines = [
        '# Commerce conversation evaluation',
        '',
        `- Completed: ${summary.completedAt}`,
        `- Scenarios: ${summary.scenarios}; passed: ${summary.passed_scenarios}; failed: ${summary.failed_scenarios}`,
        `- Quality failures: ${summary.quality_failed_scenarios}; infrastructure failures: ${summary.infrastructure_failed_scenarios}`,
        `- Turns: ${summary.turns}; passed: ${summary.passed_turns}; failed: ${summary.failed_turns}`,
        '',
        '## Failure reasons',
        ''
    ];
    for (const [reason, count] of Object.entries(summary.failure_reasons)) {
        lines.push(`- ${count} — ${reason}`);
    }
    if (Object.keys(summary.failure_reasons).length === 0) lines.push('- None');
    lines.push('', '## Infrastructure failures', '');
    if (summary.infrastructure_failures.length === 0) {
        lines.push('- None');
    } else {
        for (const failure of summary.infrastructure_failures) {
            lines.push(`- ${escapeMarkdownCell(failure.scenario_id)} — ${escapeMarkdownCell(failure.type)} after ${failure.attempts} scenario attempt(s): ${inlineEvidence(failure.error)}`);
        }
    }
    lines.push('', '## Failed scenarios', '');
    if (failed.length === 0) {
        lines.push('- None');
    } else {
        for (const result of failed) {
            lines.push(`- ${result.id} (${result.failed_turns} failed turn${result.failed_turns === 1 ? '' : 's'})`);
        }
    }

    lines.push('', '## Scenario matrix', '', '| Scenario | Locale | Result | Turns |', '| --- | --- | --- | --- |');
    for (const result of results) {
        const completed = result.turns.length;
        const total = result.turns.length;
        lines.push(`| ${escapeMarkdownCell(result.id)} | ${escapeMarkdownCell(result.locale)} | ${result.passed ? 'PASS' : 'FAIL'} | ${completed}/${total} |`);
    }

    lines.push('', '## Failure evidence', '');
    if (failed.length === 0) {
        lines.push('- None');
    } else {
        for (const result of failed) {
            lines.push(`### ${result.id}`, '');
            for (const [index, turn] of result.turns.entries()) {
                if (turn.evaluation?.passed) continue;
                lines.push(`#### Turn ${index + 1}`, '', `- Prompt: ${inlineEvidence(turn.prompt)}`);
                if (Array.isArray(turn.tools) && turn.tools.length > 0) {
                    lines.push(`- Tools: ${turn.tools.map(inlineEvidence).join(', ')}`);
                }
                if (Array.isArray(turn.products) && turn.products.length > 0) {
                    lines.push(`- Product cards: ${turn.products.map((product) => inlineEvidence(`${product.sku} — ${product.name} — ${product.price}`)).join('; ')}`);
                }
                for (const reason of turn.evaluation?.reasons || []) {
                    lines.push(`- Failure: ${inlineEvidence(reason)}`);
                }
                if (turn.response) {
                    lines.push('', 'Response excerpt:', '', `> ${String(turn.response).replace(/\n+/gu, '\n> ').slice(0, 1800)}`, '');
                } else {
                    lines.push('');
                }
            }
        }
    }
    return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(value) {
    return String(value || '').replace(/[|\r\n]/gu, ' ').trim() || '-';
}

function inlineEvidence(value) {
    return String(value || '').replace(/[\r\n]+/gu, ' ').replace(/`/gu, '\\`').trim() || '[empty]';
}

function waitForEvent(socket, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(transportError('Timed out while connecting to the AI gateway.'));
        }, timeoutMs);
        const onMessage = (raw) => {
            try {
                const event = JSON.parse(raw.toString());
                if (!predicate(event)) return;
                cleanup();
                resolve(event);
            } catch {}
        };
        const onError = (error) => {
            cleanup();
            reject(transportError(`WebSocket error while connecting: ${error?.message || String(error)}.`, error));
        };
        const onClose = (code, reason) => {
            cleanup();
            reject(transportError(`WebSocket closed while connecting (code ${code}${reason ? `: ${reason.toString()}` : ''}).`));
        };
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('message', onMessage);
            socket.off('error', onError);
            socket.off('close', onClose);
        };
        socket.on('message', onMessage);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

async function retryTransientTransport(operation, task) {
    let lastError;
    for (let attempt = 0; attempt <= transportRetryLimit; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            if (!isTransientTransportError(error) || attempt >= transportRetryLimit) throw error;
            const delay = transportRetryDelayMs * (attempt + 1);
            console.warn(`Transient transport failure while trying to ${operation}; retrying (${attempt + 1}/${transportRetryLimit}) after ${delay}ms.`);
            await sleep(delay);
        }
    }
    throw lastError;
}

function transportError(message, cause = null) {
    const error = new Error(message);
    error.isTransientTransportFailure = true;
    if (cause) error.cause = cause;
    return error;
}

function providerUnavailableError(message, cause = null) {
    const error = new Error(message);
    error.isProviderUnavailable = true;
    if (cause) error.cause = cause;
    return error;
}

function isTransientTransportError(error) {
    if (error?.isTransientTransportFailure === true) return true;
    const message = String(error?.message || error || '');
    return /\b(?:HTTP\s*)?(?:502|503|504|520|522|524|530)\b|(?:econnreset|econnrefused|enotfound|etimedout|fetch failed|socket hang up|network error)/iu.test(message);
}

function isProviderUnavailableError(error) {
    return error?.isProviderUnavailable === true;
}

function isTransientHttpStatus(status) {
    return [502, 503, 504, 520, 522, 524, 530].includes(Number(status));
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWithConcurrency(values, maxConcurrency, worker, onResult = null) {
    const results = new Array(values.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, values.length) }, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await worker(values[index]);
            if (typeof onResult === 'function') await onResult(results[index], index, results);
        }
    }));
    return results;
}

/**
 * Keep an inspectable checkpoint while a public run is in flight. A full
 * conversation matrix can take hours when a provider invokes several Magento
 * tools per turn; the final Markdown must still be written only after all
 * scenarios finish, but a JSON checkpoint prevents an interrupted run from
 * becoming unobservable. Writes are serialized so concurrency cannot replace
 * a newer checkpoint with an older partial result set.
 */
function queueProgressSnapshot(results) {
    const completedResults = results.filter(Boolean);
    progressWriteQueue = progressWriteQueue
        .catch(() => undefined)
        .then(async () => {
            const checkpointedAt = new Date().toISOString();
            const summary = summarize(completedResults, {
                checkpointedAt,
                storefrontUrl,
                wsUrl,
                total_scenarios: scenarios.length,
                completed_scenarios: completedResults.length
            });
            await writeFile(
                resolve(reportDirectory, reportFileName('progress.json')),
                `${JSON.stringify({ status: 'in_progress', summary, results: completedResults }, null, 2)}\n`,
                'utf8'
            );
        });
    return progressWriteQueue;
}

function parseArgs(args) {
    const parsed = {};
    for (const argument of args) {
        const match = argument.match(/^--([a-z-]+)=(.+)$/);
        if (match) parsed[match[1]] = match[2];
    }
    return parsed;
}

function safeReportSuffix(value) {
    const suffix = String(value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9-]{0,80}$/.test(suffix) ? suffix : '';
}

function reportFileName(extension) {
    return reportSuffix
        ? `conversation-eval-${reportSuffix}.${extension}`
        : `latest-conversation-eval.${extension}`;
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
}
