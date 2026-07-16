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
        safeSources.push({
            title: String(source?.title || '').trim().slice(0, 240) || parsed.hostname,
            url
        });
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

/**
 * Ask the configured AI provider to use its own native Web Search capability.
 * This request is deliberately isolated from the main chat-completions stream:
 * an unsupported provider can never break ordinary storefront chat.
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

    if (!safeQuery) {
        return unavailable('invalid_query', 'A web search needs a clear, non-empty query.');
    }
    if (containsPrivateData(safeQuery)) {
        return unavailable(
            'private_data_blocked',
            'Web Search was not used because the query contains private account, contact, or order information.'
        );
    }
    if (!SUPPORTED_PROVIDERS.has(normalizedProvider) || !endpoint || !apiKey || !model) {
        return unavailable(
            'provider_web_search_unavailable',
            'The current AI provider or model does not offer Web Search for this chat.'
        );
    }

    if (normalizedProvider === 'gemini') {
        return searchGeminiWithGrounding({
            query: safeQuery,
            baseUrl: endpoint,
            apiKey,
            model,
            signal,
            fetchImpl,
            dnsLookup
        });
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
        // Compatibility fallback below keeps ordinary chat usable when this
        // Cockpit build does not expose Codex indexed search.
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
        return unavailable(
            reason,
            reason === 'provider_web_search_unavailable'
                ? 'The current AI provider or model does not offer Web Search for this chat.'
                : 'Web Search is temporarily unavailable, but normal chat is still available.'
        );
    }

    const result = collectResponseOutput(payload);
    const safeSources = await filterSafePublicSources(result.sources, dnsLookup);
    const compatibilitySearchUsed = normalizedProvider === 'cockpit'
        && Boolean(result.answer)
        && safeSources.length > 0;
    if (!result.searchUsed && !compatibilitySearchUsed) {
        return unavailable(
            'provider_web_search_unavailable',
            'The current AI provider or model accepted the request but did not provide Web Search access.'
        );
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
    parseSafeWebUrl
};
