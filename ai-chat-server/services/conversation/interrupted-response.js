function stoppedAfterSeconds(startedAt, stoppedAt) {
    const started = Number(startedAt);
    const stopped = Number(stoppedAt);

    if (!Number.isFinite(started) || !Number.isFinite(stopped)) {
        return 0;
    }

    return Math.max(0, Math.floor((stopped - started) / 1000));
}

export function interruptedResponseMetadata(startedAt, stoppedAt = Date.now(), reason = '') {
    const metadata = {
        interrupted: true,
        stopped_after_seconds: stoppedAfterSeconds(startedAt, stoppedAt)
    };
    // A reload closes the ticket-authenticated socket before an assistant
    // token may exist. Keep that distinct from the shopper explicitly pressing
    // Stop so the restored UI can describe the recovery action accurately.
    if (reason === 'connection_lost') metadata.interruption_reason = reason;
    return metadata;
}

export function buildInterruptedAssistantPayload(parts, startedAt, stoppedAt = Date.now(), reason = '') {
    const visibleParts = (Array.isArray(parts) ? parts : [])
        .filter((part) => part?.type === 'text' || part?.type === 'image')
        .map((part) => part?.type === 'image'
            ? {
                type: 'image',
                url: String(part.url || ''),
                alt: String(part.alt || 'Generated image').slice(0, 400),
                prompt: String(part.prompt || '').slice(0, 4000),
                size: String(part.size || ''),
                quality: String(part.quality || '')
            }
            : {
                type: 'text',
                raw: String(part.raw || part.text || '')
            })
        .filter((part) => part.type === 'image' ? /^https?:\/\//i.test(part.url) : part.raw.trim() !== '');

    return {
        ...interruptedResponseMetadata(startedAt, stoppedAt, reason),
        parts: visibleParts
    };
}
