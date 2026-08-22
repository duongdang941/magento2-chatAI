/**
 * Provider-neutral response metadata.
 *
 * Provider payloads never cross the storefront boundary. Adapters reduce the
 * useful, bounded fields to this envelope so analytics/history can compare
 * OpenAI, Cockpit, Anthropic and Gemini turns consistently.
 */
const MAX_CITATIONS = 20;
const MAX_TEXT = 600;

function text(value, max = MAX_TEXT) {
    return String(value || '').trim().slice(0, max);
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function createProviderResponseEnvelope({ provider = '', protocol = '', model = '', startedAt = Date.now() } = {}) {
    return {
        version: 1,
        provider: text(provider, 80),
        protocol: text(protocol, 80),
        model: text(model, 160),
        finish_reason: '',
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cached_input_tokens: 0,
            reasoning_tokens: 0
        },
        citations: [],
        latency_ms: 0,
        _started_at: Number(startedAt) || Date.now()
    };
}

export function mergeProviderUsage(envelope, source = {}) {
    if (!envelope || !source || typeof source !== 'object') return envelope;
    const input = source.input_tokens ?? source.prompt_tokens ?? source.promptTokenCount;
    const output = source.output_tokens ?? source.completion_tokens ?? source.candidatesTokenCount;
    const total = source.total_tokens ?? source.totalTokenCount;
    const cached = source.cached_input_tokens
        ?? source.cached_tokens
        ?? source.cachedContentTokenCount
        ?? source.prompt_tokens_details?.cached_tokens
        ?? source.input_tokens_details?.cached_tokens
        ?? source.cache_read_input_tokens;
    const reasoning = source.reasoning_tokens
        ?? source.thoughtsTokenCount
        ?? source.completion_tokens_details?.reasoning_tokens
        ?? source.output_tokens_details?.reasoning_tokens;

    const usage = envelope.usage;
    if (input !== undefined) usage.input_tokens = Math.max(usage.input_tokens, finite(input));
    if (output !== undefined) usage.output_tokens = Math.max(usage.output_tokens, finite(output));
    if (total !== undefined) usage.total_tokens = Math.max(usage.total_tokens, finite(total));
    if (cached !== undefined) usage.cached_input_tokens = Math.max(usage.cached_input_tokens, finite(cached));
    if (reasoning !== undefined) usage.reasoning_tokens = Math.max(usage.reasoning_tokens, finite(reasoning));
    if (usage.total_tokens === 0 && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }
    return envelope;
}

export function addProviderCitations(envelope, candidates = []) {
    if (!envelope || !Array.isArray(candidates)) return envelope;
    for (const candidate of candidates) {
        const source = typeof candidate === 'string' ? { url: candidate } : candidate;
        const nested = source?.web || source?.retrievedContext || source?.source || {};
        const url = text(source?.url || source?.uri || nested.url || nested.uri, 2048);
        if (!/^https:\/\//i.test(url)) continue;
        if (envelope.citations.some((item) => item.url === url)) continue;
        envelope.citations.push({
            url,
            ...(text(source.title || source.name || nested.title || nested.name, 240) ? { title: text(source.title || source.name || nested.title || nested.name, 240) } : {}),
            ...(text(source.snippet || source.description || nested.snippet || nested.description, MAX_TEXT) ? { snippet: text(source.snippet || source.description || nested.snippet || nested.description, MAX_TEXT) } : {})
        });
        if (envelope.citations.length >= MAX_CITATIONS) break;
    }
    return envelope;
}

export function finalizeProviderResponseEnvelope(envelope, finishReason = '') {
    if (!envelope) return null;
    envelope.finish_reason = text(finishReason, 80);
    envelope.latency_ms = Math.max(0, Date.now() - (Number(envelope._started_at) || Date.now()));
    delete envelope._started_at;
    return envelope;
}

export function normalizeProviderResponseMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = createProviderResponseEnvelope(value);
    envelope.finish_reason = text(value.finish_reason, 80);
    envelope.latency_ms = finite(value.latency_ms);
    mergeProviderUsage(envelope, value.usage || value);
    addProviderCitations(envelope, value.citations);
    return envelope;
}
