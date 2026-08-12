function stoppedAfterSeconds(startedAt, stoppedAt) {
    const started = Number(startedAt);
    const stopped = Number(stoppedAt);

    if (!Number.isFinite(started) || !Number.isFinite(stopped)) {
        return 0;
    }

    return Math.max(0, Math.floor((stopped - started) / 1000));
}

export function interruptedResponseMetadata(startedAt, stoppedAt = Date.now()) {
    return {
        interrupted: true,
        stopped_after_seconds: stoppedAfterSeconds(startedAt, stoppedAt)
    };
}

export function buildInterruptedAssistantPayload(parts, startedAt, stoppedAt = Date.now()) {
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
        ...interruptedResponseMetadata(startedAt, stoppedAt),
        parts: visibleParts
    };
}
