/**
 * Level-based gateway logger.
 *
 * Structured metadata is redacted before it reaches stdout: credentials and
 * session material are dropped entirely, customer emails are masked, and
 * customer/conversation identifiers are replaced by stable short hashes so a
 * log line remains correlatable without exposing the raw id.
 *
 * Levels: debug < info < warn < error. Threshold comes from
 * AI_LOG_LEVEL (or LOG_LEVEL) and defaults to `info`, so debug tracing is
 * silent in production unless explicitly enabled.
 */
import crypto from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN = /cookie|token|secret|password|authorization|api[-_]?key|session/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resolveThreshold() {
    const raw = String(process.env.AI_LOG_LEVEL || process.env.LOG_LEVEL || 'info').trim().toLowerCase();
    return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
}

function maskEmail(value) {
    const source = String(value || '');
    if (!EMAIL_PATTERN.test(source)) {
        return '[redacted]';
    }
    const [local, domain] = source.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
}

function aliasIdentifier(kind, value) {
    if (value === null || value === undefined || value === '' || value === 0) {
        return value;
    }
    return `${kind}:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8)}`;
}

function redact(value, depth = 0) {
    if (depth > 4) {
        return '[truncated]';
    }
    if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
        const output = {};
        for (const [key, entry] of Object.entries(value)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                output[key] = '[redacted]';
            } else if (/email/i.test(key)) {
                output[key] = maskEmail(entry);
            } else if (/customerId|customer_id/i.test(key)) {
                output[key] = aliasIdentifier('customer', entry);
            } else if (/conversationId|conversation_id/i.test(key)) {
                output[key] = aliasIdentifier('conversation', entry);
            } else {
                output[key] = redact(entry, depth + 1);
            }
        }
        return output;
    }
    if (typeof value === 'string' && value.length > 512) {
        return `${value.slice(0, 512)}…`;
    }
    return value;
}

function emit(level, tag, args) {
    if (LEVELS[level] < resolveThreshold()) {
        return;
    }
    const prefix = `[afd-ai][${level}] ${String(tag || 'gateway')}`;
    const serialized = args.map((arg) => (
        arg && typeof arg === 'object' ? JSON.stringify(redact(arg)) : arg
    ));
    console[level === 'debug' ? 'log' : level](prefix, ...serialized);
}

export const logger = {
    debug: (tag, ...args) => emit('debug', tag, args),
    info: (tag, ...args) => emit('info', tag, args),
    warn: (tag, ...args) => emit('warn', tag, args),
    error: (tag, ...args) => emit('error', tag, args)
};
