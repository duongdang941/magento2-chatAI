import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SUPPORTED_PROVIDERS = new Set(['gemini', 'openai', 'openrouter', '9router', 'cockpit']);
const MAX_QUERY_LENGTH = 500;
const MAX_ANSWER_LENGTH = 12000;
const MAX_SOURCES = 8;
const MAX_SEARCH_CANDIDATES = 16;
const MAX_SNIPPET_LENGTH = 900;
const COCKPIT_SEARCH_ATTEMPTS = 2;
const SAFE_WEB_PORTS = new Set(['', '80', '443']);
const BUILT_IN_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BUILT_IN_SEARCH_TIMEOUT_MS = 15000;
const BLOCKED_HOST_SUFFIXES = [
    '.internal',
    '.invalid',
    '.lan',
    '.local',
    '.localhost',
    '.test'
];

function normalizeQuery(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_QUERY_LENGTH);
}

function containsPrivateData(value) {
    const text = String(value || '');
    return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
        || /\b(?:order|don hang|bestellung|phone|dien thoai|telefon)\s*[#:.-]*\s*[A-Z0-9-]{6,}\b/i.test(text)
        || /\b\d{8,}\b/.test(text);
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function geminiGenerateContentUrl(baseUrl, model) {
    const configured = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const safeModel = encodeURIComponent(String(model || '').trim());
    if (!safeModel) return '';
    if (/\/models$/i.test(configured)) return `${configured}/${safeModel}:generateContent`;
    return `${configured}/models/${safeModel}:generateContent`;
}

function geminiTextAndSources(payload) {
    const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const answer = parts
        .map((part) => String(part?.text || ''))
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(0, MAX_ANSWER_LENGTH);
    const chunks = Array.isArray(candidate?.groundingMetadata?.groundingChunks)
        ? candidate.groundingMetadata.groundingChunks
        : [];
    const sources = chunks
        .map((chunk) => chunk?.web)
        .filter((web) => web?.uri)
        .map((web) => ({ title: String(web.title || '').trim(), url: String(web.uri || '').trim() }));
    return { answer, sources };
}

async function searchGeminiWithGrounding({ query, baseUrl, apiKey, model, signal, fetchImpl, dnsLookup }) {
    const url = geminiGenerateContentUrl(baseUrl, model);
    if (!url) return unavailable('provider_web_search_unavailable', 'The Gemini grounding model is not configured.');

    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: query }] }],
                tools: [{ googleSearch: {} }],
                generationConfig: { maxOutputTokens: 2048 }
            }),
            signal
        });
    } catch {
        return unavailable('provider_web_search_temporarily_unavailable', 'Gemini Web Search is temporarily unreachable.');
    }

    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
        return unavailable(
            [400, 404, 405, 422].includes(Number(response.status))
                ? 'provider_web_search_unavailable'
                : 'provider_web_search_temporarily_unavailable',
            'The configured Gemini model does not currently provide Google Search grounding.'
        );
    }

    const result = geminiTextAndSources(payload);
    const sources = await filterSafePublicSources(result.sources, dnsLookup);
    if (!result.answer || sources.length === 0) {
        return unavailable('provider_web_search_unavailable', 'Gemini did not return verifiable Google Search sources.');
    }
    return {
        status: 'success',
        query,
        answer: result.answer,
        sources,
        count: sources.length
    };
}

function buildSearchInput(query, provider) {
    if (provider !== 'cockpit') return query;

    return [
        'Search the public web for the following request.',
        'Return a concise final answer with at least one directly relevant public source formatted as a Markdown link [source title](https://...).',
        'Do not return progress narration.',
        `Request: ${query}`
    ].join(' ');
}

function normalizeEvidenceText(value, maxLength = MAX_SNIPPET_LENGTH) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/<[^>]{0,500}>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function isPublicIpv4(address) {
    const octets = String(address || '').split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    const [a, b, c] = octets;
    return !(
        a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0 && c === 0)
        || (a === 192 && b === 0 && c === 2)
        || (a === 192 && b === 168)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224
    );
}

function isPublicIpv6(address) {
    const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!normalized || normalized === '::' || normalized === '::1') return false;
    if (/^(?:fc|fd|fe|ff)/.test(normalized)) return false;
    if (normalized.startsWith('2001:db8:')) return false;

    if (normalized.startsWith('::ffff:')) {
        const mappedValue = normalized.slice('::ffff:'.length);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(mappedValue)) return isPublicIpv4(mappedValue);

        const hextets = mappedValue.split(':');
        if (hextets.length !== 2 || hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return false;
        const high = Number.parseInt(hextets[0], 16);
        const low = Number.parseInt(hextets[1], 16);
        return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }

    return true;
}

function isPublicIp(address) {
    const family = isIP(String(address || '').replace(/^\[|\]$/g, ''));
    if (family === 4) return isPublicIpv4(address);
    if (family === 6) return isPublicIpv6(address);
    return false;
}

function parseSafeWebUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value || '').trim());
    } catch {
        return null;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || !SAFE_WEB_PORTS.has(parsed.port)) return null;

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname || hostname === 'localhost') return null;
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
    if (isIP(hostname) && !isPublicIp(hostname)) return null;

    parsed.hash = '';
    return parsed;
}

function trimUrlPunctuation(value) {
    return String(value || '').replace(/[\)\].,;:!?]+$/g, '');
}

function extractLinkedSources(text) {
    const sourceMap = new Map();
    const content = String(text || '');
    const markdownPattern = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s)]+)\)/gi;
    const rawUrlPattern = /https?:\/\/[^\s<>"']+/gi;

    for (const match of content.matchAll(markdownPattern)) {
        const url = trimUrlPunctuation(match[2]);
        if (!sourceMap.has(url)) {
            sourceMap.set(url, { title: match[1].trim().slice(0, 240), url });
        }
        if (sourceMap.size >= MAX_SOURCES) return Array.from(sourceMap.values());
    }

    for (const match of content.matchAll(rawUrlPattern)) {
        const url = trimUrlPunctuation(match[0]);
        if (!sourceMap.has(url)) sourceMap.set(url, { title: '', url });
        if (sourceMap.size >= MAX_SOURCES) break;
    }

    return Array.from(sourceMap.values());
}

async function filterSafePublicSources(sources, dnsLookup = lookup) {
    const safeSources = [];

    for (const source of Array.isArray(sources) ? sources : []) {
        const parsed = parseSafeWebUrl(source?.url);
        if (!parsed) continue;

        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (!isIP(hostname)) {
            let addresses = [];
            try {
                addresses = await dnsLookup(hostname, { all: true, verbatim: true });
            } catch {
                continue;
            }
            if (!Array.isArray(addresses) || addresses.length === 0) continue;
            if (addresses.some((entry) => !isPublicIp(entry?.address))) continue;
        }

        const url = parsed.toString();
        const safeSource = {
            title: String(source?.title || '').trim().slice(0, 240) || parsed.hostname,
            url
        };
        const excerpt = normalizeEvidenceText(source?.excerpt ?? source?.snippet);
        if (excerpt) safeSource.excerpt = excerpt;
        safeSources.push(safeSource);
        if (safeSources.length >= MAX_SOURCES) break;
    }

    return safeSources;
}

async function collectCockpitSearchEvidence(payload, dnsLookup = lookup) {
    const candidates = (Array.isArray(payload?.results) ? payload.results : [])
        .filter((item) => item?.type === 'text_result' || (!item?.type && item?.url))
        .slice(0, MAX_SEARCH_CANDIDATES)
        .map((item) => ({
            title: normalizeEvidenceText(item?.title, 240),
            url: String(item?.url || '').trim(),
            snippet: normalizeEvidenceText(item?.snippet)
        }));
    const safeSources = await filterSafePublicSources(candidates, dnsLookup);
    if (safeSources.length === 0) return null;

    const evidenceByUrl = new Map();
    for (const candidate of candidates) {
        const parsed = parseSafeWebUrl(candidate.url);
        if (parsed) evidenceByUrl.set(parsed.toString(), candidate.snippet);
    }

    const answer = safeSources.map((source, index) => {
        const snippet = evidenceByUrl.get(source.url) || 'No excerpt was returned.';
        return [
            `[${index + 1}] ${source.title}`,
            `URL: ${source.url}`,
            `Excerpt: ${snippet}`
        ].join('\n');
    }).join('\n\n').slice(0, MAX_ANSWER_LENGTH);

    return {
        status: 'success',
        answer,
        sources: safeSources,
        count: safeSources.length
    };
}

async function requestCockpitSearch({ endpoint, apiKey, model, query, signal, fetchImpl }) {
    const turnId = randomUUID();
    const response = await fetchImpl(`${endpoint}/alpha/search`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            id: randomUUID(),
            model,
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: query }],
                internal_chat_message_metadata_passthrough: { turn_id: turnId }
            }],
            commands: {
                search_query: [{ q: query }],
                response_length: 'medium'
            },
            settings: {
                allowed_callers: ['direct'],
                // Match Codex Desktop's indexed-search lane. Cockpit rejects
                // live external access for local OAuth accounts with HTTP 401.
                external_web_access: false
            },
            max_output_tokens: 10000
        }),
        signal
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {}

    return { response, payload };
}

function collectResponseOutput(payload) {
    const output = Array.isArray(payload?.output) ? payload.output : [];
    const searchUsed = output.some((item) => item?.type === 'web_search_call');
    const texts = [];
    const finalTexts = [];
    const sourceMap = new Map();

    for (const item of output) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;

        for (const content of item.content) {
            if (content?.type === 'output_text' && typeof content.text === 'string') {
                texts.push(content.text);
                if (item.phase === 'final_answer') finalTexts.push(content.text);
            }

            for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
                const citation = annotation?.type === 'url_citation'
                    ? (annotation.url_citation || annotation)
                    : null;
                const url = String(citation?.url || '').trim();
                if (!/^https?:\/\//i.test(url) || sourceMap.has(url)) continue;

                sourceMap.set(url, {
                    title: String(citation?.title || '').trim().slice(0, 240),
                    url
                });
                if (sourceMap.size >= MAX_SOURCES) break;
            }
        }
    }

    const answer = (finalTexts.length > 0 ? finalTexts : texts)
        .join('\n')
        .trim()
        .slice(0, MAX_ANSWER_LENGTH);
    for (const source of extractLinkedSources(answer)) {
        if (!sourceMap.has(source.url)) sourceMap.set(source.url, source);
        if (sourceMap.size >= MAX_SOURCES) break;
    }

    return {
        searchUsed,
        answer,
        sources: Array.from(sourceMap.values())
    };
}

function unavailable(reason, message) {
    return {
        status: 'unavailable',
        reason,
        message,
        sources: [],
        count: 0
    };
}

function isZCodeSearchRouterEndpoint(baseUrl) {
    try {
        const hostname = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
        return hostname === '9router.com'
            || hostname.endsWith('.9router.com')
            || hostname === '9router.bingxgames.com'
            || hostname.endsWith('.9router.bingxgames.com');
    } catch {
        return false;
    }
}

function automaticRouterSearchConnection({ provider, baseUrl, apiKey }) {
    const providerCode = String(provider || '').trim().toLowerCase();
    return {
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey: String(apiKey || '').trim(),
        provider: /^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerCode) ? providerCode : '',
        maxResults: 5,
        timeoutMs: 15000
    };
}

function routerSearchUrl(baseUrl) {
    const endpoint = normalizeBaseUrl(baseUrl);
    if (!endpoint) return '';
    if (/\/search$/i.test(endpoint)) return endpoint;
    return /\/v1$/i.test(endpoint) ? `${endpoint}/search` : `${endpoint}/v1/search`;
}

function routerSearchCandidates(payload) {
    const results = Array.isArray(payload?.results)
        ? payload.results
        : (Array.isArray(payload?.data?.results) ? payload.data.results : []);

    return results.slice(0, MAX_SEARCH_CANDIDATES).map((result) => ({
        title: normalizeEvidenceText(result?.title || result?.name, 240),
        url: String(result?.url || result?.link || '').trim(),
        excerpt: normalizeEvidenceText(result?.snippet ?? result?.excerpt ?? result?.description ?? result?.content)
    }));
}

function buildRouterEvidenceAnswer(answer, sources) {
    const normalizedAnswer = normalizeEvidenceText(answer, MAX_ANSWER_LENGTH);
    const evidence = (Array.isArray(sources) ? sources : [])
        .map((source, index) => {
            const excerpt = normalizeEvidenceText(source?.excerpt, MAX_SNIPPET_LENGTH);
            if (!excerpt) return '';
            return [
                `[${index + 1}] ${source.title}`,
                `URL: ${source.url}`,
                `Excerpt: ${excerpt}`
            ].join('\n');
        })
        .filter(Boolean)
        .join('\n\n');

    return [normalizedAnswer, evidence]
        .filter(Boolean)
        .join(normalizedAnswer && evidence ? '\n\n' : '')
        .slice(0, MAX_ANSWER_LENGTH);
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_match, name) => ({
            amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '
        })[String(name).toLowerCase()] || '');
}

function htmlText(value) {
    return normalizeEvidenceText(decodeHtmlEntities(String(value || '').replace(/<[^>]{0,500}>/g, ' ')));
}

function unwrapDuckDuckGoUrl(value) {
    const href = decodeHtmlEntities(value).trim();
    if (!href) return '';
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    try {
        const parsed = new URL(absolute);
        if (parsed.hostname.toLowerCase().endsWith('duckduckgo.com') && /^\/l\/?$/i.test(parsed.pathname)) {
            return parsed.searchParams.get('uddg') || '';
        }
    } catch {
        return '';
    }
    return absolute;
}

function extractBuiltInSearchCandidates(html) {
    const candidates = [];
    const resultPattern = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi;
    const matches = Array.from(String(html || '').matchAll(resultPattern));

    for (let index = 0; index < matches.length && candidates.length < MAX_SEARCH_CANDIDATES; index += 1) {
        const match = matches[index];
        const nextOffset = matches[index + 1]?.index ?? String(html || '').length;
        const resultWindow = String(html || '').slice(match.index + match[0].length, nextOffset);
        const snippetMatch = resultWindow.match(/<[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
        const url = unwrapDuckDuckGoUrl(match[1]);
        if (!url) continue;
        candidates.push({
            title: htmlText(match[2]).slice(0, 240),
            url,
            excerpt: htmlText(snippetMatch?.[1])
        });
    }

    return candidates;
}

async function searchWithBuiltInWeb({ query, signal, fetchImpl, dnsLookup }) {
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Built-in Web Search request timed out.'));
    }, BUILT_IN_SEARCH_TIMEOUT_MS);

    try {
        const url = new URL(BUILT_IN_SEARCH_ENDPOINT);
        url.searchParams.set('q', query);
        url.searchParams.set('kp', '-2');
        url.searchParams.set('kl', 'wt-wt');
        const response = await fetchImpl(url.toString(), {
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'Mozilla/5.0 (compatible; AfdAI-WebSearch/1.0)'
            },
            signal: controller.signal
        });
        if (!response.ok) {
            return unavailable(
                'provider_web_search_temporarily_unavailable',
                'Built-in Web Search is temporarily unavailable, but normal chat is still available.'
            );
        }

        const sources = await filterSafePublicSources(
            extractBuiltInSearchCandidates(await response.text()),
            dnsLookup
        );
        const answer = buildRouterEvidenceAnswer('', sources);
        if (sources.length === 0 || !answer) {
            return unavailable(
                'provider_web_search_unavailable',
                'Built-in Web Search did not return verifiable public sources.'
            );
        }
        return {
            status: 'success',
            query,
            answer,
            sources,
            count: sources.length
        };
    } catch {
        return unavailable(
            'provider_web_search_temporarily_unavailable',
            timedOut
                ? 'Built-in Web Search timed out, but normal chat is still available.'
                : 'Built-in Web Search is temporarily unavailable, but normal chat is still available.'
        );
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', forwardAbort);
    }
}

async function fallBackToBuiltInWeb(primary, options) {
    const result = await primary();
    return result?.status === 'success' ? result : searchWithBuiltInWeb(options);
}

async function requestRouterSearch({ endpoint, apiKey, provider, query, maxResults, timeoutMs, signal, fetchImpl }) {
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Web Search request timed out.'));
    }, timeoutMs);

    try {
        const response = await fetchImpl(routerSearchUrl(endpoint), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                provider,
                query,
                max_results: maxResults
            }),
            signal: controller.signal
        });
        let payload = null;
        try { payload = await response.json(); } catch {}
        return { response, payload, timedOut: false };
    } catch (error) {
        return { error, timedOut };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', forwardAbort);
    }
}

async function searchWithRouter({ query, connection, signal, fetchImpl, dnsLookup }) {
    if (!connection.baseUrl || !connection.apiKey || !connection.provider) {
        return unavailable(
            'provider_web_search_unavailable',
            'The selected provider does not have the connection details required for Web Search.'
        );
    }

    const result = await requestRouterSearch({
        endpoint: connection.baseUrl,
        apiKey: connection.apiKey,
        provider: connection.provider,
        query,
        maxResults: connection.maxResults,
        timeoutMs: connection.timeoutMs,
        signal,
        fetchImpl
    });
    if (result.error) {
        return unavailable(
            'provider_web_search_temporarily_unavailable',
            result.timedOut
                ? 'Web Search timed out, but normal chat is still available.'
                : 'Web Search is temporarily unreachable, but normal chat is still available.'
        );
    }
    if (!result.response?.ok) {
        const reason = [400, 401, 403, 404, 405, 422].includes(Number(result.response?.status))
            ? 'provider_web_search_unavailable'
            : 'provider_web_search_temporarily_unavailable';
        return unavailable(
            reason,
            reason === 'provider_web_search_unavailable'
                ? 'The selected provider cannot run Web Search at this time.'
                : 'Web Search is temporarily unavailable, but normal chat is still available.'
        );
    }

    const sources = await filterSafePublicSources(routerSearchCandidates(result.payload), dnsLookup);
    if (sources.length === 0) {
        return unavailable(
            'provider_web_search_unavailable',
            'The Web Search service did not return verifiable public sources.'
        );
    }
    const answer = buildRouterEvidenceAnswer(result.payload?.answer, sources);
    if (!answer) {
        return unavailable(
            'provider_web_search_unavailable',
            'The Web Search service returned sources without usable evidence excerpts.'
        );
    }

    return {
        status: 'success',
        query,
        answer,
        sources,
        count: sources.length
    };
}

/**
 * Perform public Web Search without ever making regular chat unavailable. The
 * built-in host fallback mirrors ZCode's WebSearch tool: it is independent of
 * the selected model provider and needs no Merchant Admin configuration.
 */
export async function searchWebWithAi({
    query,
    provider,
    baseUrl,
    apiKey,
    model,
    signal = null,
    fetchImpl = fetch,
    dnsLookup = lookup
} = {}) {
    const safeQuery = normalizeQuery(query);
    const normalizedProvider = String(provider || '').toLowerCase();
    const endpoint = normalizeBaseUrl(baseUrl);
    const useBuiltInHostFallback = normalizedProvider === 'cockpit';
    const builtInFallback = () => searchWithBuiltInWeb({
        query: safeQuery,
        signal,
        fetchImpl,
        dnsLookup
    });

    if (!safeQuery) {
        return unavailable('invalid_query', 'A web search needs a clear, non-empty query.');
    }
    if (containsPrivateData(safeQuery)) {
        return unavailable(
            'private_data_blocked',
            'Web Search was not used because the query contains private account, contact, or order information.'
        );
    }

    // 9router is ZCode-compatible: the provider already owns the connection
    // and the selected provider code is the search backend selector. Its
    // optional /search service is used when configured there; otherwise Afd's
    // built-in host tool provides the same zero-config fallback as ZCode.
    if (isZCodeSearchRouterEndpoint(endpoint)) {
        return fallBackToBuiltInWeb(() => searchWithRouter({
            query: safeQuery,
            connection: automaticRouterSearchConnection({ provider: normalizedProvider, baseUrl: endpoint, apiKey }),
            signal,
            fetchImpl,
            dnsLookup
        }), { query: safeQuery, signal, fetchImpl, dnsLookup });
    }

    if (!SUPPORTED_PROVIDERS.has(normalizedProvider) || !endpoint || !apiKey || !model) {
        return unavailable(
            'provider_web_search_unavailable',
            'The current AI provider or model does not offer Web Search for this chat.'
        );
    }

    if (normalizedProvider === 'gemini') {
        return fallBackToBuiltInWeb(() => searchGeminiWithGrounding({
            query: safeQuery,
            baseUrl: endpoint,
            apiKey,
            model,
            signal,
            fetchImpl,
            dnsLookup
        }), { query: safeQuery, signal, fetchImpl, dnsLookup });
    }

    if (normalizedProvider === 'cockpit') {
        for (let attempt = 0; attempt < COCKPIT_SEARCH_ATTEMPTS; attempt += 1) {
            try {
                const cockpitSearch = await requestCockpitSearch({
                    endpoint,
                    apiKey,
                    model,
                    query: safeQuery,
                    signal,
                    fetchImpl
                });
                if (cockpitSearch.response.ok) {
                    const evidence = await collectCockpitSearchEvidence(cockpitSearch.payload, dnsLookup);
                    if (evidence) return { ...evidence, query: safeQuery };
                    continue;
                }
                if (Number(cockpitSearch.response.status) < 500) break;
            } catch {
                // Retry once for a transient local proxy/search failure.
            }
        }
        // The Responses compatibility fallback below remains available for
        // Cockpit. If it cannot search either, use the host-side fallback.
    }

    let response;
    try {
        response = await fetchImpl(`${endpoint}/responses`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                model,
                input: buildSearchInput(safeQuery, normalizedProvider),
                tools: [{ type: 'web_search' }],
                tool_choice: { type: 'web_search' },
                include: ['web_search_call.action.sources']
            }),
            signal
        });
    } catch {
        if (useBuiltInHostFallback) return builtInFallback();
        return unavailable(
            'provider_web_search_temporarily_unavailable',
            'Web Search is temporarily unreachable, but normal chat is still available.'
        );
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch {}

    if (!response.ok) {
        const reason = [400, 404, 405, 422].includes(Number(response.status))
            ? 'provider_web_search_unavailable'
            : 'provider_web_search_temporarily_unavailable';
        const unavailableResult = unavailable(
            reason,
            reason === 'provider_web_search_unavailable'
                ? 'The current AI provider or model does not offer Web Search for this chat.'
                : 'Web Search is temporarily unavailable, but normal chat is still available.'
        );
        return useBuiltInHostFallback ? builtInFallback() : unavailableResult;
    }

    const result = collectResponseOutput(payload);
    const safeSources = await filterSafePublicSources(result.sources, dnsLookup);
    const compatibilitySearchUsed = normalizedProvider === 'cockpit'
        && Boolean(result.answer)
        && safeSources.length > 0;
    if (!result.searchUsed && !compatibilitySearchUsed) {
        const unavailableResult = unavailable(
            'provider_web_search_unavailable',
            'The current AI provider or model accepted the request but did not provide Web Search access.'
        );
        return useBuiltInHostFallback ? builtInFallback() : unavailableResult;
    }

    return {
        status: 'success',
        query: safeQuery,
        answer: result.answer,
        sources: safeSources,
        count: safeSources.length
    };
}

export {
    collectCockpitSearchEvidence,
    collectResponseOutput,
    containsPrivateData,
    extractLinkedSources,
    filterSafePublicSources,
    normalizeQuery,
    parseSafeWebUrl,
    routerSearchUrl,
    isZCodeSearchRouterEndpoint
};
