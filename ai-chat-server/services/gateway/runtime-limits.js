function readPositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(Math.trunc(parsed), max));
}

/**
 * Keep deployment overrides bounded in one place. The composition root only
 * consumes this immutable snapshot; Magento-synchronised values still take
 * precedence at request time where the gateway supports them.
 */
export function getGatewayRuntimeLimits(environment = process.env) {
    const maxWebSocketPayloadBytes = readPositiveInt(
        environment.MAX_WS_PAYLOAD_BYTES,
        8 * 1024 * 1024,
        12 * 1024 * 1024
    );
    const maxWebSocketImageReserveBytes = 2 * 1024 * 1024;

    return Object.freeze({
        maxMessagesPerMinute: readPositiveInt(environment.MAX_MESSAGES_PER_MINUTE, 15, 120),
        maxProductPageRequestsPerMinute: readPositiveInt(environment.MAX_PRODUCT_PAGE_REQUESTS_PER_MINUTE, 30, 120),
        maxAddressUpdatesPerMinute: readPositiveInt(environment.MAX_ADDRESS_UPDATES_PER_MINUTE, 5, 30),
        maxAddressUpdatesPerHour: readPositiveInt(environment.MAX_ADDRESS_UPDATES_PER_HOUR, 20, 200),
        maxModelHistoryMessages: readPositiveInt(environment.MAX_MODEL_HISTORY_MESSAGES, 16, 40),
        maxImageBytes: readPositiveInt(environment.MAX_IMAGE_BYTES, 4 * 1024 * 1024, 16 * 1024 * 1024),
        maxImagesPerMessage: readPositiveInt(environment.MAX_IMAGES_PER_MESSAGE, 4, 4),
        maxWebSocketPayloadBytes,
        maxWebSocketEncodedImageBytes: Math.max(512 * 1024, maxWebSocketPayloadBytes - maxWebSocketImageReserveBytes),
        maxConcurrentModelRequests: readPositiveInt(environment.MAX_CONCURRENT_MODEL_REQUESTS, 32, 1000),
        maxQueueDepth: readPositiveInt(environment.MAX_QUEUE_DEPTH, 200, 10000),
        maxQueueWaitMs: readPositiveInt(environment.MAX_QUEUE_WAIT_MS, 30000, 300000),
        modelLeaseMs: readPositiveInt(environment.MODEL_LEASE_MS, 90000, 600000),
        addressUpdateLockMs: readPositiveInt(environment.ADDRESS_UPDATE_LOCK_MS, 20000, 60000)
    });
}
