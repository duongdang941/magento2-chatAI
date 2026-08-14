import { toolPolicy } from '../tools/tool-registry.js';

/**
 * Provider-neutral authorization guard. It intentionally evaluates structured
 * tool policy and Magento-signed identity only; it does not use keyword lists
 * to guess a shopper's language or intent.
 */
export function authorizeCommerceTool({ name, args = {}, config = {}, options = {} } = {}) {
    const policy = toolPolicy(name);
    if (!policy) {
        return { allowed: false, reason: 'unknown_tool', risk: 'unknown' };
    }
    if (config.features?.guardrails_enabled === false) {
        return { allowed: true, reason: 'guardrails_disabled', risk: policy.risk };
    }
    if (policy.requiresCustomer && !(Number(options.customerId) > 0)) {
        return { allowed: false, reason: 'authenticated_customer_required', risk: policy.risk };
    }
    if (policy.risk === 'destructive' && args.confirmed !== true) {
        return { allowed: false, reason: 'explicit_confirmation_required', risk: policy.risk };
    }
    if (policy.risk === 'external_read' && !String(args.query || '').trim()) {
        return { allowed: false, reason: 'external_query_required', risk: policy.risk };
    }
    return { allowed: true, reason: 'authorized', risk: policy.risk };
}
