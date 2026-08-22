const SENSITIVE_VALUE_PATTERNS = [
    /(bearer\s+)[^\s,;]+/gi,
    /(oauth_(?:consumer_key|consumer_secret|token|token_secret)["'=:\s]+)[^\s,;"']+/gi,
    /((?:api[_-]?key|authorization|token|secret)["'=:\s]+)[^\s,;"']+/gi
];

function redact(value) {
    return SENSITIVE_VALUE_PATTERNS.reduce(
        (message, pattern) => message.replace(pattern, '$1[REDACTED]'),
        String(value || '')
    );
}

function cleanOperationalMessage(value) {
    return redact(value)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[a-z][^>]*>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Axios errors include request headers and can contain credentials. Logs must
 * retain only actionable operational fields, never the raw error object.
 */
export function summarizeError(error) {
    const response = error?.response;
    const responseMessage = response?.data && typeof response.data === 'object'
        ? response.data.message || response.data.error || ''
        : '';

    return {
        status: Number.isInteger(response?.status) ? response.status : undefined,
        code: error?.code ? String(error.code).slice(0, 80) : undefined,
        message: cleanOperationalMessage(responseMessage || error?.message || 'Unknown error').slice(0, 300)
    };
}
