#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';

import { conversationScenarios } from '../evals/conversation-scenarios.mjs';

const options = parseArgs(process.argv.slice(2));
const limit = clampNumber(options.limit, conversationScenarios.length, 1, conversationScenarios.length);
const concurrency = clampNumber(options.concurrency || process.env.AI_EVAL_CONCURRENCY, 4, 1, 8);
const storefrontUrl = requiredUrl('AI_EVAL_STOREFRONT_URL', /^https?:\/\//i);
const wsUrl = requiredUrl('AI_EVAL_WS_URL', /^wss?:\/\//i);
const reportDirectory = resolve(process.cwd(), 'evals/reports');
const scenarios = conversationScenarios.slice(0, limit);

function requiredUrl(name, pattern) {
    const value = String(process.env[name] || '').trim().replace(/\/+$/, '');
    if (!pattern.test(value)) {
        throw new Error(`${name} must be supplied by the target environment.`);
    }
    return value;
}

console.log(`Running ${scenarios.length} conversation scenarios with concurrency ${concurrency}.`);
const results = await runWithConcurrency(scenarios, concurrency, runScenario);
const completedAt = new Date().toISOString();
const summary = summarize(results, { completedAt, storefrontUrl, wsUrl });

await mkdir(reportDirectory, { recursive: true });
await writeFile(
    resolve(reportDirectory, 'latest-conversation-eval.json'),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
    'utf8'
);
await writeFile(
    resolve(reportDirectory, 'latest-conversation-eval.md'),
    renderMarkdownReport(summary, results),
    'utf8'
);

console.log(JSON.stringify(summary, null, 2));
if (summary.failed_scenarios > 0) process.exitCode = 1;

async function runScenario(scenario) {
    let socket = null;
    const history = [];
    const turns = [];

    try {
        socket = await openGatewaySocket();
        for (let index = 0; index < scenario.turns.length; index += 1) {
            const turn = scenario.turns[index];
            const response = await runTurn(socket, turn.text, history, `${scenario.id}-${index + 1}`);
            const evaluation = evaluateTurn(turn, response);
            turns.push({
                prompt: turn.text,
                expected: turn.expect,
                statuses: response.statuses,
                response: response.text,
                product_count: response.products.length,
                evaluation
            });

            history.push({ role: 'user', parts: [{ text: turn.text }] });
            history.push({
                role: 'model',
                parts: [{ text: [response.text, buildCatalogContext(response.products)].filter(Boolean).join('\n\n') }]
            });
        }
    } catch (error) {
        turns.push({
            prompt: null,
            expected: [],
            statuses: [],
            response: '',
            product_count: 0,
            evaluation: { passed: false, reasons: [error.message || String(error)] }
        });
    } finally {
        socket?.close();
    }

    const failedTurns = turns.filter((turn) => !turn.evaluation.passed);
    return {
        id: scenario.id,
        title: scenario.title,
        locale: scenario.locale,
        catalog_topic: scenario.catalog_topic.key,
        passed: failedTurns.length === 0,
        failed_turns: failedTurns.length,
        turns
    };
}

async function openGatewaySocket() {
    const ticketResponse = await fetch(`${storefrontUrl}/afd_ai/chat/session`, {
        headers: { Accept: 'application/json' }
    });
    if (!ticketResponse.ok) throw new Error(`Could not fetch WebSocket ticket (HTTP ${ticketResponse.status}).`);
    const ticketPayload = await ticketResponse.json();
    if (ticketPayload.status !== 'success' || !ticketPayload.websocketTicket) {
        throw new Error('Magento did not issue a WebSocket ticket.');
    }

    const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticketPayload.websocketTicket)}`);
    await waitForEvent(socket, (event) => event.type === 'auth', 15000);
    return socket;
}

async function runTurn(socket, text, history, requestId) {
    const statuses = [];
    const products = [];
    let responseText = '';

    const finished = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${requestId}.`));
        }, 120000);

        const onMessage = (raw) => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (event.type === 'status') statuses.push(String(event.content || ''));
            if (event.type === 'tool_activity' && event.state === 'running') {
                statuses.push(toolActivityStatus(event.tool));
            }
            if (event.type === 'chunk') responseText += String(event.content || '');
            if (event.type === 'products_html' && Array.isArray(event.products?.items)) {
                products.push(...event.products.items);
            }
            if (event.type === 'error' || event.type === 'busy') {
                cleanup();
                reject(new Error(String(event.content || event.error_code || 'Gateway returned an error.')));
            }
            if (event.type === 'done') {
                cleanup();
                resolve();
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('message', onMessage);
        };
        socket.on('message', onMessage);
        socket.send(JSON.stringify({ action: 'chat', request_id: requestId, text, history }));
    });

    await finished;
    return { text: responseText.trim(), statuses, products };
}

function toolActivityStatus(toolName) {
    switch (String(toolName || '')) {
        case 'searchProducts':
        case 'listCategories':
            return 'Searching products';
        case 'getProductAvailability':
            return 'Checking live availability';
        default:
            return `Using ${String(toolName || 'store tool')}`;
    }
}

function evaluateTurn(turn, response) {
    const reasons = [];
    const answer = String(response.text || '').trim();
    const statuses = response.statuses.join('\n').toLowerCase();
    const expects = new Set(turn.expect || []);

    if (answer.length < 12) reasons.push('Response is empty or too short.');
    if (expects.has('search') && !statuses.includes('searching products')) {
        reasons.push('Expected a catalog search tool call.');
    }
    if (expects.has('availability') && !statuses.includes('checking live availability')) {
        reasons.push('Expected a live availability tool call.');
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

    return { passed: reasons.length === 0, reasons };
}

function buildCatalogContext(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const entries = items.slice(0, 12).map((item, index) => {
        if (!item?.sku || !item?.name) return '';
        return `#${index + 1}: name="${item.name}"; sku="${item.sku}"; product_ref="${item.product_ref || `product:${item.id || ''}`}"; price="${item.price || ''}"; type=${item.product_type || 'simple'}; requires_variant_selection=${item.requires_variant_selection === true}; options="${[item.sizes, item.colors].filter(Boolean).join(' | ')}"`;
    }).filter(Boolean);
    return entries.length > 0
        ? `[CATALOG_CONTEXT: sản phẩm đã hiện; dùng SKU này khi hỏi tiếp, luôn kiểm tra tồn kho mới.]\n${entries.join('\n')}`
        : '';
}

function summarize(results, context) {
    const totalTurns = results.reduce((sum, result) => sum + result.turns.length, 0);
    const failedTurns = results.reduce((sum, result) => sum + result.failed_turns, 0);
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
        turns: totalTurns,
        passed_turns: totalTurns - failedTurns,
        failed_turns: failedTurns,
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
        `- Turns: ${summary.turns}; passed: ${summary.passed_turns}; failed: ${summary.failed_turns}`,
        '',
        '## Failure reasons',
        ''
    ];
    for (const [reason, count] of Object.entries(summary.failure_reasons)) {
        lines.push(`- ${count} — ${reason}`);
    }
    if (Object.keys(summary.failure_reasons).length === 0) lines.push('- None');
    lines.push('', '## Failed scenarios', '');
    if (failed.length === 0) {
        lines.push('- None');
    } else {
        for (const result of failed) {
            lines.push(`- ${result.id} (${result.failed_turns} failed turn${result.failed_turns === 1 ? '' : 's'})`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function waitForEvent(socket, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out while connecting to the AI gateway.'));
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
            reject(error);
        };
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('message', onMessage);
            socket.off('error', onError);
        };
        socket.on('message', onMessage);
        socket.on('error', onError);
    });
}

async function runWithConcurrency(values, maxConcurrency, worker) {
    const results = new Array(values.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, values.length) }, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await worker(values[index]);
        }
    }));
    return results;
}

function parseArgs(args) {
    const parsed = {};
    for (const argument of args) {
        const match = argument.match(/^--([a-z-]+)=(.+)$/);
        if (match) parsed[match[1]] = match[2];
    }
    return parsed;
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
}
