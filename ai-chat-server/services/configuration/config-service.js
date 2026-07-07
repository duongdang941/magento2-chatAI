import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sealConfig, unsealConfig } from './config-seal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `__dirname` is `services/configuration`; configuration is operational state
// for the whole gateway, not a file inside the source services directory.
// Keeping it beside the gateway logs also makes a restart read the same
// snapshot that Magento last synchronized.
const CONFIG_DIRECTORY = process.env.AI_CONFIG_DIRECTORY || path.join(__dirname, '../../.local');
const CONFIG_FILE = process.env.AI_CONFIG_FILE || path.join(CONFIG_DIRECTORY, 'ai-config.json');
const VALID_PROVIDERS = new Set(['gemini', 'openai', 'openrouter', '9router', 'cockpit']);
const MAGENTO_OAUTH_FIELDS = [
    'consumer_key',
    'consumer_secret',
    'access_token',
    'access_token_secret'
];
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const IMAGE_QUALITIES = new Set(['low', 'medium', 'high']);

let cachedConfig = null;
const STORE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function defaultModelForProvider(provider) {
    switch (provider) {
        case 'openai':
            return 'gpt-4o-mini';
        case 'openrouter':
            return 'google/gemini-flash-1.5';
        case '9router':
            return 'cx/gpt-5.5';
        case 'cockpit':
            return process.env.COCKPIT_MODEL || 'gpt-5.6-luna';
        case 'gemini':
        default:
            return 'gemini-3.1-flash-lite';
    }
}

function configuredBaseUrlForProvider(provider, configuredBaseUrl = '') {
    switch (provider) {
        case '9router':
            return configuredBaseUrl || process.env.NINE_ROUTER_BASE_URL || 'https://raud4eq.9router.com/v1';
        case 'cockpit':
            return configuredBaseUrl || process.env.COCKPIT_BASE_URL || 'http://127.0.0.1:49998/v1';
        case 'gemini':
            return configuredBaseUrl || process.env.GEMINI_ENDPOINT || '';
        default:
            return configuredBaseUrl || '';
    }
}

function getProviderApiKey(provider) {
    switch (provider) {
        case 'openai':
            return process.env.OPENAI_API_KEY || '';
        case 'openrouter':
            return process.env.OPENROUTER_API_KEY || '';
        case '9router':
            return process.env.NINE_ROUTER_API_KEY || '';
        case 'cockpit':
            return process.env.COCKPIT_API_KEY || '';
        case 'gemini':
        default:
            return process.env.GEMINI_API_KEY || '';
    }
}

function readString(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function hasOwn(object, property) {
    return Object.prototype.hasOwnProperty.call(object, property);
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

function normalizeBoolean(value, fallback) {
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return fallback;
}

function normalizeMagentoOauth(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    return Object.fromEntries(
        MAGENTO_OAUTH_FIELDS.map((field) => [field, readString(source[field])])
    );
}

function normalizeImageGeneration(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const size = readString(source.size, process.env.COCKPIT_IMAGE_SIZE || '1024x1024');
    const quality = readString(source.quality, process.env.COCKPIT_IMAGE_QUALITY || 'medium');

    return {
        enabled: hasOwn(source, 'enabled') ? Boolean(source.enabled) : process.env.IMAGE_GENERATION_ENABLED !== '0',
        model: readString(source.model, process.env.COCKPIT_IMAGE_MODEL || 'gpt-image-2'),
        size: IMAGE_SIZES.has(size) ? size : '1024x1024',
        quality: IMAGE_QUALITIES.has(quality) ? quality : 'medium',
        timeout_ms: clampInteger(source.timeout_ms, 180000, 30000, 300000),
        customer_per_hour: clampInteger(source.customer_per_hour, 3, 1, 100),
        customer_per_day: clampInteger(source.customer_per_day, 10, 1, 500),
        guest_per_hour: clampInteger(source.guest_per_hour, 2, 1, 50),
        guest_per_day: clampInteger(source.guest_per_day, 5, 1, 200),
        cooldown_seconds: clampInteger(source.cooldown_seconds, 60, 0, 3600),
        max_concurrent_per_identity: clampInteger(source.max_concurrent_per_identity, 1, 1, 3)
    };
}

function normalizeAgent(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    return {
        max_tool_rounds: clampInteger(source.max_tool_rounds, 8, 1, 12),
        max_tool_executions: clampInteger(source.max_tool_executions, 15, 1, 30),
        max_category_calls: clampInteger(source.max_category_calls, 3, 1, 10),
        block_duplicate_tool_calls: normalizeBoolean(source.block_duplicate_tool_calls, true),
        max_output_tokens: clampInteger(source.max_output_tokens, 2048, 256, 8192),
        max_model_history_messages: clampInteger(source.max_model_history_messages, 20, 4, 40),
        max_history_tokens: clampInteger(source.max_history_tokens, 12000, 512, 64000),
        max_tool_context_tokens: clampInteger(source.max_tool_context_tokens, 6000, 256, 24000),
        provider_stream_timeout_ms: clampInteger(source.provider_stream_timeout_ms, 120000, 10000, 300000)
    };
}

function normalizeRateLimits(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    return {
        messages_per_minute: clampInteger(source.messages_per_minute, 15, 1, 120),
        product_pages_per_minute: clampInteger(source.product_pages_per_minute, 30, 1, 120),
        address_updates_per_minute: clampInteger(source.address_updates_per_minute, 5, 1, 30),
        address_updates_per_hour: clampInteger(source.address_updates_per_hour, 20, 1, 200)
    };
}

function normalizeCapacity(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    return {
        concurrent_model_requests: clampInteger(source.concurrent_model_requests, 32, 1, 1000),
        queue_depth: clampInteger(source.queue_depth, 200, 1, 10000),
        queue_wait_ms: clampInteger(source.queue_wait_ms, 30000, 1000, 300000),
        model_lease_ms: clampInteger(source.model_lease_ms, 180000, 10000, 600000)
    };
}

function normalizeAttachments(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    return {
        max_image_bytes: clampInteger(source.max_image_bytes, 4 * 1024 * 1024, 256 * 1024, 16 * 1024 * 1024),
        max_images_per_message: clampInteger(source.max_images_per_message, 4, 1, 4),
        max_total_image_bytes: clampInteger(source.max_total_image_bytes, 6 * 1024 * 1024, 256 * 1024, 8 * 1024 * 1024),
        max_total_encoded_bytes: clampInteger(source.max_total_encoded_bytes, 6 * 1024 * 1024, 512 * 1024, 6 * 1024 * 1024),
        max_total_pixels: clampInteger(source.max_total_pixels, 30_000_000, 1_000_000, 50_000_000),
        vision_concurrency: clampInteger(source.vision_concurrency, 4, 1, 32),
        cost_units_per_minute: clampInteger(source.cost_units_per_minute, 30, 5, 300),
        network_cost_units_per_minute: clampInteger(source.network_cost_units_per_minute, 120, 10, 1000),
        global_cost_units_per_minute: clampInteger(source.global_cost_units_per_minute, 1200, 100, 10000)
    };
}

function normalizeVoice(value, provider) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const liveSource = source.live && typeof source.live === 'object' && !Array.isArray(source.live)
        ? source.live
        : {};

    return {
        enabled: hasOwn(source, 'enabled') ? Boolean(source.enabled) : true,
        transcription_model: readString(source.transcription_model, 'gpt-4o-mini-transcribe'),
        max_duration_seconds: clampInteger(source.max_duration_seconds, 120, 5, 300),
        max_audio_bytes: clampInteger(source.max_audio_bytes, 4 * 1024 * 1024, 256 * 1024, 4 * 1024 * 1024),
        requests_per_minute: clampInteger(source.requests_per_minute, 6, 1, 30),
        max_concurrent_per_identity: clampInteger(source.max_concurrent_per_identity, 1, 1, 2),
        timeout_ms: clampInteger(source.timeout_ms, 120000, 10000, 180000),
        // Live voice has a provider credential of its own.  A compatible
        // chat endpoint (for example Cockpit) is not assumed to implement
        // OpenAI's Realtime protocol.
        live: {
            enabled: provider === 'openai' && hasOwn(liveSource, 'enabled') && Boolean(liveSource.enabled),
            api_key: provider === 'openai'
                ? readString(liveSource.api_key, process.env.OPENAI_REALTIME_API_KEY || '')
                : '',
            model: provider === 'openai' ? readString(liveSource.model, 'gpt-realtime-1.5') : '',
            max_sessions_per_minute: clampInteger(liveSource.max_sessions_per_minute, 3, 1, 30),
            max_duration_seconds: clampInteger(liveSource.max_duration_seconds, 600, 30, 1800)
        }
    };
}

export function normalizeConfig(config = {}) {
    const requestedProvider = readString(config.provider, process.env.AI_PROVIDER || 'cockpit');
    const provider = VALID_PROVIDERS.has(requestedProvider) ? requestedProvider : 'cockpit';
    const configuredApiKey = readString(config.api_key) || getProviderApiKey(provider);

    return {
        enabled: hasOwn(config, 'enabled') ? Boolean(config.enabled) : true,
        persist_guest_history: hasOwn(config, 'persist_guest_history') ? Boolean(config.persist_guest_history) : false,
        provider,
        model: readString(config.model, defaultModelForProvider(provider)),
        api_key: configuredApiKey,
        base_url: configuredBaseUrlForProvider(provider, readString(config.base_url)),
        // Magento is the source of truth for the storefront URL.  The
        // environment value remains only as a backwards-compatible local
        // bootstrap when no Admin snapshot has been synchronized yet.
        magento_base_url: readString(config.magento_base_url, process.env.MAGENTO_API_URL || ''),
        agent: normalizeAgent(config.agent),
        image_generation: normalizeImageGeneration(config.image_generation),
        rate_limits: normalizeRateLimits(config.rate_limits),
        capacity: normalizeCapacity(config.capacity),
        attachments: normalizeAttachments(config.attachments),
        voice: normalizeVoice(config.voice, provider),
        magento_oauth: normalizeMagentoOauth(config.magento_oauth)
    };
}

function normalizeConfigSnapshot(config = {}) {
    const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const rawStores = source.stores && typeof source.stores === 'object' && !Array.isArray(source.stores)
        ? source.stores
        : {};
    const stores = {};
    for (const [storeCode, value] of Object.entries(rawStores)) {
        if (!STORE_CODE_PATTERN.test(storeCode)) continue;
        stores[storeCode] = normalizeConfig(value);
    }

    return {
        version: 2,
        default: normalizeConfig(source.default && typeof source.default === 'object' ? source.default : source),
        stores
    };
}

function resolveStoreConfig(snapshot, storeCode = '') {
    const normalizedStoreCode = String(storeCode || '').trim();
    return snapshot.stores?.[normalizedStoreCode] || snapshot.default;
}

function loadConfigFromDisk() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return normalizeConfigSnapshot(unsealConfig(parsed));
    } catch (error) {
        console.error('Could not read the local AI configuration snapshot:', error.message);
        return null;
    }
}

function persistConfigSnapshot(config) {
    try {
        fs.mkdirSync(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
        const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
        const sealed = sealConfig({
            ...config,
            synced_at: new Date().toISOString()
        });
        fs.writeFileSync(temporaryFile, JSON.stringify(sealed, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        fs.renameSync(temporaryFile, CONFIG_FILE);
        fs.chmodSync(CONFIG_FILE, 0o600);
    } catch (error) {
        console.error('Could not persist the local AI configuration snapshot:', error.message);
        throw new Error('Could not persist the local configuration snapshot.');
    }
}

/**
 * Return the last configuration accepted by the Node service. The service no
 * longer fetches configuration from Magento during a customer chat request.
 */
export const getAiConfigSnapshot = async (runtime = null) => {
    if (runtime) {
        const distributedConfig = await runtime.getConfig();
        if (distributedConfig) {
            const snapshot = normalizeConfigSnapshot(unsealConfig(distributedConfig));
            // Keep the last accepted snapshot available to small Magento
            // adapters that only receive a signed store scope. This avoids
            // falling back to a stale/local domain between chat requests.
            cachedConfig = { value: snapshot, source: 'distributed_snapshot' };
            return snapshot;
        }
    }

    if (cachedConfig) return cachedConfig.value;

    const config = loadConfigFromDisk() || normalizeConfigSnapshot({});
    cachedConfig = {
        value: config,
        source: fs.existsSync(CONFIG_FILE) ? 'local_snapshot' : 'runtime_environment'
    };
    return config;
};

export const getAiConfig = async (runtime = null, storeCode = '') => (
    resolveStoreConfig(await getAiConfigSnapshot(runtime), storeCode)
);

/**
 * Apply a signed Magento configuration push. Validation of the HMAC request
 * happens in server.js; this function validates and persists only the payload.
 */
export const applyPushedConfig = async (config, runtime = null) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Configuration payload must be an object.');
    }

    const rawDefault = config.default && typeof config.default === 'object' ? config.default : config;
    const requestedProvider = readString(rawDefault.provider);
    if (!VALID_PROVIDERS.has(requestedProvider)) {
        throw new Error('Default configuration provider is not supported.');
    }

    const rawStores = config.stores && typeof config.stores === 'object' && !Array.isArray(config.stores)
        ? config.stores
        : {};
    for (const [storeCode, storeConfig] of Object.entries(rawStores)) {
        if (!STORE_CODE_PATTERN.test(storeCode)
            || !VALID_PROVIDERS.has(readString(storeConfig?.provider))) {
            throw new Error('Store configuration is invalid.');
        }
    }

    const normalized = normalizeConfigSnapshot({
        default: rawDefault,
        stores: rawStores
    });

    persistConfigSnapshot(normalized);
    if (runtime) {
        await runtime.setConfig(sealConfig(normalized));
    }
    cachedConfig = {
        value: normalized,
        source: 'magento_push'
    };

    return normalized;
};

export const clearConfigCache = () => {
    cachedConfig = null;
};

/** Return the synchronized Magento website URL for a store view. */
export function getMagentoBaseUrl(storeCode = '') {
    const snapshot = cachedConfig?.value || loadConfigFromDisk() || normalizeConfigSnapshot({});
    const config = resolveStoreConfig(snapshot, storeCode);
    return readString(config.magento_base_url, process.env.MAGENTO_API_URL || '').replace(/\/+$/, '');
}
