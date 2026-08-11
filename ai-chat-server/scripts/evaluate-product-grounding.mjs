#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { productGroundTruthCases } from '../evals/product-ground-truth-cases.mjs';
import { buildLocalGatewayEnvironment } from '../services/local-magento-bootstrap.js';

Object.assign(process.env, buildLocalGatewayEnvironment());
const { getAiConfig } = await import('../services/config-service.js');
const { getOrchestrator } = await import('../services/orchestrator-factory.js');

const options = parseArgs(process.argv.slice(2));
const limit = clamp(options.limit, productGroundTruthCases.length, 1, productGroundTruthCases.length);
const concurrency = clamp(options.concurrency || process.env.AI_PRODUCT_EVAL_CONCURRENCY, 3, 1, 6);
const selectedCases = productGroundTruthCases.filter((testCase) => {
    if (options.group && testCase.group !== options.group) return false;
    if (options.id && !String(options.id).split(',').includes(testCase.id)) return false;
    return true;
});
const cases = selectedCases.slice(0, Math.min(limit, selectedCases.length));
const config = await getAiConfig();
const streamChatResponse = await getOrchestrator(config.provider);
const reportDirectory = resolve(process.cwd(), 'evals/reports');

console.log(`Running ${cases.length} product grounding cases with concurrency ${concurrency}.`);
const results = await runWithConcurrency(cases, concurrency, runCase);
const summary = summarize(results);

await mkdir(reportDirectory, { recursive: true });
await writeFile(
    resolve(reportDirectory, 'latest-product-grounding-eval.json'),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
    'utf8'
);
await writeFile(
    resolve(reportDirectory, 'latest-product-grounding-eval.md'),
    renderMarkdown(summary, results),
    'utf8'
);

console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;

async function runCase(testCase) {
    const startedAt = Date.now();
    const events = [];
    const products = [];
    const toolOutcomes = [];
    let answer = '';
    let error = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    const ws = {
        send(raw) {
            const event = JSON.parse(raw);
            events.push(event.type);
            if (event.type === 'chunk') answer += String(event.content || '');
            if (event.type === 'products_html' && Array.isArray(event.products?.items)) {
                products.push(...event.products.items);
            }
            if (event.type === 'error') error = String(event.content || 'Gateway returned an error.');
        }
    };

    try {
        await streamChatResponse(
            { text: testCase.prompt },
            ws,
            [],
            '',
            config,
            {
                signal: controller.signal,
                isCancelled: () => controller.signal.aborted,
                customerId: null,
                guestId: `product-eval-${testCase.id}`,
                sessionCookie: '',
                onToolOutcome(outcome) {
                    toolOutcomes.push({
                        name: String(outcome?.name || ''),
                        query: String(outcome?.query || ''),
                        response_language: String(outcome?.responseLanguage || ''),
                        returned_skus: Array.isArray(outcome?.content?.data)
                            ? outcome.content.data.map(item => String(item?.sku || '')).filter(Boolean)
                            : [],
                        catalog_request: outcome?.catalogRequest || {},
                        scope: outcome?.content?.scope || {}
                    });
                }
            }
        );
    } catch (caught) {
        error = caught?.message || String(caught);
    } finally {
        clearTimeout(timeout);
    }

    const evaluation = evaluate(testCase, { answer, products, error, events });
    const result = {
        id: testCase.id,
        group: testCase.group,
        prompt: testCase.prompt,
        expected_skus: testCase.expectedSkus || [],
        disabled_skus: testCase.disabledSkus || [],
        answer: answer.trim(),
        returned_products: products.map((product) => ({
            sku: String(product?.sku || ''),
            name: String(product?.name || '')
        })),
        tool_outcomes: toolOutcomes,
        events,
        duration_ms: Date.now() - startedAt,
        ...evaluation
    };
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${testCase.id} (${result.duration_ms} ms)`);
    return result;
}

function evaluate(testCase, response) {
    const reasons = [];
    const answer = normalize(response.answer);
    const returnedSkus = new Set(response.products.map((product) => String(product?.sku || '').toLowerCase()));
    const returnedNames = response.products.map((product) => normalize(product?.name));

    if (response.error) reasons.push(`Gateway error: ${response.error}`);
    if (response.answer.trim().length < 12) reasons.push('Response is empty or too short.');
    if (!response.events.includes('done')) reasons.push('The turn did not emit done.');
    if (looksLikeGermanOrEnglishProse(response.answer)) {
        reasons.push('The Vietnamese shopper response switched to German or English prose.');
    }

    if (testCase.group === 'active_exact' || testCase.group === 'active_typo') {
        if (!testCase.expectedSkus.some((sku) => returnedSkus.has(sku.toLowerCase()))) {
            reasons.push(`Missing expected active SKU: ${testCase.expectedSkus.join(' or ')}.`);
        }
        if (looksUnavailable(answer)) reasons.push('Claimed an active product was unavailable.');
    }

    if (testCase.group === 'disabled' || testCase.group === 'absent') {
        if (response.products.length > 0) {
            reasons.push(`Returned unrelated product cards for an unavailable exact identity: ${[...returnedSkus].join(', ')}.`);
        }
        if (!looksUnavailable(answer)) reasons.push('Did not clearly state that the exact product is unavailable/not found.');
    }

    if (testCase.group === 'broad') {
        if (response.products.length === 0) reasons.push('Broad search returned no product cards.');
        if (response.products.length > 0 && !returnedNames.some((name) =>
            testCase.allowedNameTokens.some((token) => name.includes(normalize(token))))) {
            reasons.push('Broad search cards do not match the requested product family.');
        }
    }

    return { passed: reasons.length === 0, reasons };
}

function looksUnavailable(answer) {
    return /(?:khong co trong danh muc|khong co san pham|khong tim thay|chua tim thay|khong duoc ban|khong con duoc ban|not currently available|not found|nicht.*verfugbar|nicht gefunden)/u.test(answer);
}

function looksLikeGermanOrEnglishProse(value) {
    const text = String(value || '').toLowerCase();
    const germanWords = text.match(/\b(?:ich|habe|leider|einen|eine|nicht|gefunden|verfügbar|aktuell|führt|produkt ansehen)\b/gu) || [];
    const englishWords = text.match(/\b(?:the|this|product|currently|available|not found|shop has|you can)\b/gu) || [];

    return germanWords.length >= 3 || englishWords.length >= 4;
}

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .toLowerCase();
}

function summarize(results) {
    const groups = {};
    for (const result of results) {
        groups[result.group] ||= { total: 0, passed: 0, failed: 0 };
        groups[result.group].total += 1;
        groups[result.group][result.passed ? 'passed' : 'failed'] += 1;
    }
    return {
        completed_at: new Date().toISOString(),
        total: results.length,
        passed: results.filter((result) => result.passed).length,
        failed: results.filter((result) => !result.passed).length,
        groups
    };
}

function renderMarkdown(summary, results) {
    const lines = [
        '# Product grounding evaluation',
        '',
        `- Completed: ${summary.completed_at}`,
        `- Total: ${summary.total}; passed: ${summary.passed}; failed: ${summary.failed}`,
        '',
        '## Groups',
        ''
    ];
    for (const [group, counts] of Object.entries(summary.groups)) {
        lines.push(`- ${group}: ${counts.passed}/${counts.total} passed`);
    }
    lines.push('', '## Failed cases', '');
    const failures = results.filter((result) => !result.passed);
    if (failures.length === 0) lines.push('- None');
    for (const failure of failures) {
        lines.push(`### ${failure.id}`, '', `- Prompt: ${failure.prompt}`);
        for (const reason of failure.reasons) lines.push(`- ${reason}`);
        lines.push(`- Answer: ${failure.answer || '(empty)'}`, '');
    }
    return `${lines.join('\n')}\n`;
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
    return Object.fromEntries(args.map((argument) => {
        const match = argument.match(/^--([a-z-]+)=(.+)$/);
        return match ? [match[1], match[2]] : [argument, true];
    }));
}

function clamp(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
        : fallback;
}
