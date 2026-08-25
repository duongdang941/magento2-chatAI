import crypto from 'node:crypto';

/**
 * Customer-safe progress events for tool-using model runs.
 *
 * The model supplies the short customer label in the required tool metadata.
 * The gateway validates and relays it without maintaining a hard-coded
 * language table, so every shopper language follows the same contract.
 */
export function createToolActivityId(toolCallId, toolName) {
    const callId = String(toolCallId || '').trim();
    if (callId) return `tool-${callId}`;

    const name = String(toolName || 'action')
        .replace(/[^a-z0-9_-]/gi, '-')
        .slice(0, 40) || 'action';

    return `tool-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A stable, opaque key for one continuous customer-visible operation.
 *
 * This deliberately comes from the normalized tool intent, never from the
 * model-written label.  Providers can vary grammar, language evidence, page
 * sizing, and the activity presentation while still repeating the same
 * catalogue operation.  The browser must keep that operation in its existing
 * "running" row until a genuinely different operation starts.
 */
export function createToolActivityContinuationKey({ toolName, args = {} } = {}) {
    const name = String(toolName || 'unknown').trim().slice(0, 80) || 'unknown';
    const identity = JSON.stringify(canonicalizeActivityIdentity({
        tool: name,
        args: semanticActivityArguments(name, args)
    }));

    return `activity-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export function createToolActivityPresentation({
    toolName,
    args = {},
    knownCategoryName = '',
    state = 'running'
} = {}) {
    const name = String(toolName || 'unknown');
    const activity = getActivityPresentation(args);
    const language = normalizeActivityLanguage(activity?.language);
    const categoryName = verifiedCategoryName(knownCategoryName);
    const label = materializeSearchScopeLabel(
        activityLabelForState(activity, state),
        activity?.searchScope,
        name,
        categoryIdForActivity(args),
        categoryName
    );
    const turnSummary = activityTurnSummaryForState(activity, state, { label, categoryName });

    return {
        displayKey: compactDisplayKey(name, categoryIdForActivity(args)),
        ...(language ? { language } : {}),
        ...(label ? { label } : {}),
        ...(turnSummary ? { turnSummary } : {})
    };
}

/**
 * Product search is not allowed to bypass the customer activity contract.
 * Without it the tool can still produce cards, but the shopper sees neither
 * the localized action nor the localized total-work title. This is an
 * internal admission check only; it never invents customer-facing copy.
 */
export function hasCompleteToolActivityPresentation({
    toolName,
    args = {},
    knownCategoryName = ''
} = {}) {
    const running = createToolActivityPresentation({
        toolName,
        args,
        knownCategoryName,
        state: 'running'
    });
    const completed = createToolActivityPresentation({
        toolName,
        args,
        knownCategoryName,
        state: 'completed'
    });
    const failed = createToolActivityPresentation({
        toolName,
        args,
        knownCategoryName,
        state: 'failed'
    });

    return Boolean(
        running.language
        && running.label
        && running.turnSummary
        && completed.label
        && completed.turnSummary
        && failed.label
    );
}

/**
 * Presentation metadata must never affect Magento arguments, cache identity,
 * tool budget fingerprints, or model result context.
 */
export function withoutToolActivityPresentation(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};

    const sanitized = { ...args };
    delete sanitized.activityPresentation;
    delete sanitized.activity_presentation;
    return sanitized;
}

export function emitToolActivity(ws, {
    activityId,
    continuationKey = '',
    toolName,
    state,
    result,
    presentation = null
} = {}) {
    if (!ws || typeof ws.send !== 'function') return;

    const payload = {
        type: 'tool_activity',
        activity_id: String(activityId || createToolActivityId('', toolName)),
        tool: String(toolName || 'unknown'),
        state: normalizeState(state)
    };
    const resultCount = getResultCount(result);

    if (resultCount !== null) payload.result_count = resultCount;
    const safeContinuationKey = normalizeActivityContinuationKey(continuationKey);
    const displayKey = String(presentation?.displayKey || '').trim().slice(0, 100);
    const label = safeCustomerActivityLabel(presentation?.label);
    const language = normalizeActivityLanguage(presentation?.language);
    const turnSummary = safeTurnSummary(presentation?.turnSummary);
    if (safeContinuationKey) payload.continuation_key = safeContinuationKey;
    if (displayKey) payload.display_key = displayKey;
    if (label) payload.label = label;
    if (language) payload.language = language;
    if (turnSummary) payload.turn_summary = turnSummary;
    ws.send(JSON.stringify(payload));
}

function semanticActivityArguments(toolName, args = {}) {
    const source = withoutToolActivityPresentation(args);

    if (toolName === 'searchProducts') {
        return {
            query: normalizeActivityText(source.query),
            category_id: activityCategoryId(source),
            min_price: normalizeActivityNumber(source.minPrice),
            max_price: normalizeActivityNumber(source.maxPrice),
            price_currency: normalizeActivityText(source.priceCurrency).toUpperCase(),
            direct_add_only: source.directAddOnly === true,
            exact_identity: source.exactIdentity === true,
            excluded_terms: normalizedActivityTerms(source.excludedTerms)
        };
    }

    return Object.fromEntries(Object.entries(source)
        .filter(([key]) => !isPresentationOrPagingArgument(key))
        .map(([key, value]) => [key, normalizeActivityValue(value)]));
}

function isPresentationOrPagingArgument(key) {
    return new Set([
        'activityPresentation',
        'activity_presentation',
        'responseLanguage',
        'response_language',
        'responseLanguageEvidence',
        'response_language_evidence',
        'limit',
        'limitEvidence',
        'limit_evidence',
        'page',
        'pageSize',
        'page_size',
        'offset',
        'cursor'
    ]).has(String(key || ''));
}

function normalizeActivityValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeActivityValue)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, normalizeActivityValue(item)]));
    }
    if (typeof value === 'string') return normalizeActivityText(value);
    return value;
}

function canonicalizeActivityIdentity(value) {
    if (Array.isArray(value)) return value.map(canonicalizeActivityIdentity);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeActivityIdentity(item)]));
}

function normalizeActivityText(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function normalizeActivityNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizedActivityTerms(value) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .map(normalizeActivityText)
        .filter(Boolean)))
        .sort((left, right) => left.localeCompare(right));
}

function activityCategoryId(args = {}) {
    return Math.max(0, Math.trunc(Number(args?.categoryId ?? args?.category_id) || 0));
}

function normalizeActivityContinuationKey(value) {
    const key = String(value || '').trim();
    return /^activity-[a-f0-9]{24}$/u.test(key) ? key : '';
}

function compactDisplayKey(toolName, categoryId = 0) {
    if (toolName === 'searchProducts') {
        return categoryId > 0 ? `catalog-search-category-${categoryId}` : 'catalog-search-store';
    }
    if (toolName === 'listCategories') return 'catalog-categories';
    if (toolName === 'searchWeb') return 'web-search';
    if (toolName === 'searchStoreKnowledge') return 'store-knowledge-search';
    return `tool-${String(toolName || 'unknown').replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) || 'unknown'}`;
}

function categoryIdForActivity(args) {
    return Math.max(0, Math.trunc(Number(args?.categoryId || args?.category_id) || 0));
}

function getActivityPresentation(args) {
    const value = args?.activityPresentation ?? args?.activity_presentation;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function activityLabelForState(activity, state) {
    const field = normalizeState(state) === 'completed'
        ? 'completedLabel'
        : (normalizeState(state) === 'failed' ? 'failedLabel' : 'runningLabel');
    return safeCustomerActivityLabel(activity?.[field]);
}

function activityTurnSummaryForState(activity, state, context = {}) {
    return safeTurnSummary(
        normalizeState(state) === 'running'
            ? activity?.runningSummary
            : activity?.completedSummary,
        context
    );
}

function safeCustomerActivityLabel(value) {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    if (label.length < 2 || label.length > 180) return '';
    if (/[<>`]/.test(label) || /(?:https?:\/\/|www\.)/iu.test(label)) return '';
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u.test(label)) return '';
    if (/\b(?:searchProducts|listCategories|getProductAvailability|compareProducts|addToCart|removeFromCart|searchWeb|searchStoreKnowledge)\b/iu.test(label)) return '';
    return label;
}

function materializeSearchScopeLabel(label, searchScope, toolName, categoryId, categoryName) {
    if (!label || toolName !== 'searchProducts') return withoutUnresolvedActivityTokens(label);

    const scope = materializeCategoryToken(
        safeSearchScopeLabel(searchScope),
        categoryId,
        categoryName
    );
    if (scope && label.includes('{scope}')) {
        return withoutUnresolvedActivityTokens(label.replaceAll('{scope}', scope));
    }

    // Preserve readable history created before the scope contract. New product
    // search calls always use `{scope}` and therefore identify their scope.
    return withoutUnresolvedActivityTokens(
        materializeCategoryLabel(label, toolName, categoryId, categoryName)
    );
}

function materializeCategoryLabel(label, toolName, categoryId, categoryName) {
    if (!label || toolName !== 'searchProducts' || categoryId <= 0) return label;

    return materializeCategoryToken(label, categoryId, categoryName);
}

function materializeCategoryToken(value, categoryId, categoryName) {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    if (!label || categoryId <= 0) return label;

    if (!categoryName) {
        return label.replace(/\s*\{category\}\s*/gu, ' ').replace(/\s+/g, ' ').trim();
    }

    if (label.includes('{category}')) {
        return label.replaceAll('{category}', categoryName).replace(/\s+/g, ' ').trim();
    }

    return label.toLocaleLowerCase().includes(categoryName.toLocaleLowerCase())
        ? label
        : `${label} — ${categoryName}`;
}

function safeSearchScopeLabel(value) {
    const scope = String(value || '').replace(/\s+/g, ' ').trim();
    if (scope.length < 2 || scope.length > 120) return '';
    if (/[<>`]/.test(scope) || /(?:https?:\/\/|www\.)/iu.test(scope)) return '';
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u.test(scope)) return '';
    if (/\b(?:searchProducts|listCategories|getProductAvailability|compareProducts|addToCart|removeFromCart|searchWeb|searchStoreKnowledge)\b/iu.test(scope)) return '';
    return scope;
}

function withoutUnresolvedActivityTokens(value) {
    const tokens = '\\{(?:scope|category|duration)\\}';
    return String(value || '')
        // A model can accidentally copy a search-only placeholder into a
        // category, cart, or order label. Remove the local phrase around it
        // instead of exposing a protocol token to the shopper.
        .replace(new RegExp(`\\s*\\(\\s*${tokens}\\s*\\)`, 'gu'), '')
        .replace(new RegExp(`\\s+[^\\s()]+\\s+${tokens}`, 'gu'), '')
        .replace(new RegExp(tokens, 'gu'), '')
        .replace(/\s+([,.;:!?])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim();
}

function verifiedCategoryName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function safeTurnSummary(value, { label = '', categoryName = '' } = {}) {
    const summary = String(value || '').replace(/\s+/g, ' ').trim();
    if (summary.length < 12 || summary.length > 120) return '';
    if ((summary.match(/\{duration\}/g) || []).length !== 1) return '';
    if (/[<>`]/.test(summary) || /(?:https?:\/\/|www\.)/iu.test(summary)) return '';
    if (categoryName && summary.toLocaleLowerCase().includes(categoryName.toLocaleLowerCase())) return '';
    if (sharedMeaningfulTerms(summary, label) >= 2) return '';
    return summary;
}

function sharedMeaningfulTerms(left, right) {
    const terms = (value) => new Set(String(value || '')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]{6,}/gu) || []);
    const leftTerms = terms(left);
    const rightTerms = terms(right);
    let shared = 0;
    for (const term of leftTerms) {
        if (rightTerms.has(term)) shared += 1;
    }
    return shared;
}

function normalizeActivityLanguage(value) {
    const language = String(value || '').trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(language)) return '';
    return language.slice(0, 35);
}

function normalizeState(value) {
    return ['running', 'completed', 'failed'].includes(value) ? value : 'running';
}

function getResultCount(result) {
    if (!result || typeof result !== 'object') return null;
    if (Array.isArray(result.data)) return result.data.length;

    const count = Number(result.count);
    if (Number.isFinite(count) && count >= 0) return Math.trunc(count);

    const total = Number(result.total);
    return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null;
}
