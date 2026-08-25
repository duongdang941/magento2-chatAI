const MAX_PROVIDER_ERROR_BYTES = 8192;

function statusOf(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    return Number.isInteger(status) && status > 0 ? status : 0;
}

function cleanText(value) {
    return String(value || '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[a-z][^>]*>/gi, ' ')
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
}

function messageFromBody(body) {
    const text = String(body || '').trim();
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        return cleanText(parsed?.error?.message || parsed?.message || parsed?.error || '');
    } catch {
        return cleanText(text);
    }
}

export function providerErrorCode(error) {
    const status = statusOf(error);
    const sourceCode = String(error?.code || '').toUpperCase();
    if ([401, 403].includes(status)) return 'provider_auth_failed';
    if (status === 408 || sourceCode === 'ETIMEDOUT' || sourceCode === 'ECONNRESET') return 'provider_timeout';
    if (status === 429) return 'provider_rate_limited';
    if (status >= 500 || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(sourceCode)) {
        return 'provider_unavailable';
    }
    if (status >= 400) return 'provider_request_rejected';
    return 'provider_error';
}

export function formatProviderError(error, label = 'AI provider') {
    const code = providerErrorCode(error);
    const status = statusOf(error);
    if (code === 'provider_auth_failed') return `${label} rejected the configured credentials.`;
    if (code === 'provider_timeout') return `${label} did not respond in time. Please try again shortly.`;
    if (code === 'provider_rate_limited') return `${label} is rate limiting requests. Please try again shortly.`;
    if (code === 'provider_unavailable') return `${label} is temporarily unavailable. Please try again shortly.`;
    if (code === 'provider_request_rejected') {
        // 404 almost always means a wrong model name or a base_url missing its
        // version segment (e.g. https://host/v1), so name the usual suspects.
        if (status === 404) {
            return `${label} rejected the request (HTTP 404). Check the provider base URL (must include the version path, e.g. /v1) and the model name.`;
        }
        return `${label} rejected the request${status ? ` (HTTP ${status})` : ''}. Check the provider configuration (base URL, model name, API format).`;
    }
    return `${label} could not complete the request. Please try again.`;
}

export function createProviderError(body, status = 0, label = 'AI provider') {
    const error = new Error(messageFromBody(body) || `${label} returned HTTP ${status || 500}.`);
    error.status = status;
    error.code = providerErrorCode(error);
    error.providerMessage = messageFromBody(body);
    return error;
}

export async function readProviderErrorResponse(response, label = 'AI provider') {
    const contentLength = Number(response?.headers?.get?.('content-length') || 0);
    if (contentLength > MAX_PROVIDER_ERROR_BYTES) {
        try {
            await response.body?.cancel?.();
        } catch {
            // The safe public error below is still sufficient.
        }
        return createProviderError('', response?.status || 0, label);
    }

    let body = '';
    if (response?.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
            while (bytes < MAX_PROVIDER_ERROR_BYTES) {
                const { value, done } = await reader.read();
                if (done) break;
                const remaining = MAX_PROVIDER_ERROR_BYTES - bytes;
                const chunk = value instanceof Uint8Array ? value.subarray(0, remaining) : value;
                body += decoder.decode(chunk, { stream: true });
                bytes += chunk?.byteLength || 0;
                if ((value?.byteLength || 0) > remaining) break;
            }
        } finally {
            try {
                await reader.cancel();
            } catch {
                // Response streams may already be closed.
            }
        }
    } else if (response?.text) {
        body = (await response.text()).slice(0, MAX_PROVIDER_ERROR_BYTES);
    }

    return createProviderError(body, response?.status || 0, label);
}

export { MAX_PROVIDER_ERROR_BYTES };
