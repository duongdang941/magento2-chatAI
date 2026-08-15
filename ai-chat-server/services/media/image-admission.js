const MEBIBYTE = 1024 * 1024;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** Resource cost for an already validated inline vision request. */
export function imageRequestCost(parts = []) {
    let imageCount = 0;
    let encodedBytes = 0;
    for (const part of Array.isArray(parts) ? parts : []) {
        if (part?.type === 'attachment_ref' || part?.attachment_id) {
            imageCount += 1;
            const bytes = Number(part.bytes || 1024 * 1024);
            encodedBytes += Math.ceil(bytes * 4 / 3);
            continue;
        }
        const data = String(part?.inline_data?.data || '');
        if (!data) continue;
        imageCount += 1;
        encodedBytes += Buffer.byteLength(data, 'utf8');
    }
    const binaryBytes = Math.floor(encodedBytes * 3 / 4);
    return {
        imageCount,
        binaryBytes,
        encodedBytes,
        units: imageCount === 0 ? 0 : 1 + imageCount * 2 + Math.ceil(binaryBytes / MEBIBYTE)
    };
}

/** Apply identity, network and global weighted quotas before model admission. */
export async function admitImageRequest(runtime, client, parts, config = {}) {
    const cost = imageRequestCost(parts);
    if (cost.imageCount === 0) return { allowed: true, cost };

    const limit = positiveInteger(config.cost_units_per_minute, 30);
    const networkLimit = positiveInteger(config.network_cost_units_per_minute, 120);
    const globalLimit = positiveInteger(config.global_cost_units_per_minute, 1200);
    const policies = [
        [String(client?.rateLimitKey || 'unknown'), limit],
        [String(client?.networkRateLimitKey || 'unknown'), networkLimit],
        ['global', globalLimit]
    ];

    if (typeof runtime.consumeRateLimitBatch === 'function') {
        const admission = await runtime.consumeRateLimitBatch(
            policies.map(([identity, budget]) => ({
                identity: `${identity}:vision-cost`,
                limit: budget,
                amount: cost.units,
                windowMs: 60 * 1000
            }))
        );
        if (!admission.allowed) return { ...admission, allowed: false, cost };
        return { ...admission, allowed: true, cost };
    }

    // Compatibility for isolated unit callers. The production GatewayRuntime
    // always provides the atomic batch method above.
    for (const [identity, budget] of policies) {
        const admission = await runtime.consumeRateLimit(`${identity}:vision-cost`, {
            limit: budget,
            amount: cost.units,
            windowMs: 60 * 1000
        });
        if (!admission.allowed) return { ...admission, allowed: false, cost };
    }
    return { allowed: true, cost };
}
