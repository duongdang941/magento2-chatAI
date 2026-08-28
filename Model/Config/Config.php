<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Model\Gateway\GatewaySecretManager;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Store\Model\ScopeInterface;
use Psr\Log\LoggerInterface;

class Config
{
    public const XML_PATH_ENABLED = 'afd_ai/general/enabled';
    public const XML_PATH_PERSIST_GUEST_HISTORY = 'afd_ai/general/persist_guest_history';
    public const XML_PATH_CHAT_SERVER_URL = 'afd_ai/general/chat_server_url';
    public const XML_PATH_EXPOSE_COUPON_CODES = 'afd_ai/features/expose_coupon_codes';
    public const XML_PATH_PROVIDER = 'afd_ai/general/provider';
    public const XML_PATH_MODEL = 'afd_ai/general/model';
    public const XML_PATH_THOUGHT_LEVEL = 'afd_ai/general/thought_level';

    public const XML_PATH_MAGENTO_SECURE_BASE_URL = 'web/secure/base_url';
    public const XML_PATH_MAGENTO_UNSECURE_BASE_URL = 'web/unsecure/base_url';

    public const XML_PATH_IMAGE_TIMEOUT_MS = 'afd_ai/image_generation/timeout_ms';
    public const XML_PATH_IMAGE_CUSTOMER_PER_HOUR = 'afd_ai/image_generation/customer_per_hour';
    public const XML_PATH_IMAGE_CUSTOMER_PER_DAY = 'afd_ai/image_generation/customer_per_day';
    public const XML_PATH_IMAGE_GUEST_PER_HOUR = 'afd_ai/image_generation/guest_per_hour';
    public const XML_PATH_IMAGE_GUEST_PER_DAY = 'afd_ai/image_generation/guest_per_day';
    public const XML_PATH_IMAGE_COOLDOWN_SECONDS = 'afd_ai/image_generation/cooldown_seconds';
    public const XML_PATH_IMAGE_MAX_CONCURRENT = 'afd_ai/image_generation/max_concurrent_per_identity';

    public const XML_PATH_FEATURE_CANDIDATE_MEMORY = 'afd_ai/features/candidate_memory_enabled';
    public const XML_PATH_FEATURE_PRODUCT_ADVISOR = 'afd_ai/features/product_advisor_enabled';
    public const XML_PATH_FEATURE_PROACTIVE_SUGGESTIONS = 'afd_ai/features/proactive_suggestions_enabled';
    public const XML_PATH_FEATURE_ANALYTICS_ATTRIBUTION = 'afd_ai/features/analytics_attribution_enabled';
    public const XML_PATH_FEATURE_GUARDRAILS = 'afd_ai/features/guardrails_enabled';

    public const XML_PATH_RATE_MESSAGES_PER_MINUTE = 'afd_ai/rate_limits/messages_per_minute';
    public const XML_PATH_RATE_PRODUCT_PAGES_PER_MINUTE = 'afd_ai/rate_limits/product_pages_per_minute';
    public const XML_PATH_RATE_ADDRESS_UPDATES_PER_MINUTE = 'afd_ai/rate_limits/address_updates_per_minute';
    public const XML_PATH_RATE_ADDRESS_UPDATES_PER_HOUR = 'afd_ai/rate_limits/address_updates_per_hour';

    public const XML_PATH_CONCURRENT_MODEL_REQUESTS = 'afd_ai/capacity/concurrent_model_requests';
    public const XML_PATH_QUEUE_DEPTH = 'afd_ai/capacity/queue_depth';
    public const XML_PATH_QUEUE_WAIT_MS = 'afd_ai/capacity/queue_wait_ms';
    public const XML_PATH_MODEL_LEASE_MS = 'afd_ai/capacity/model_lease_ms';

    public const XML_PATH_MAX_TOOL_ROUNDS = 'afd_ai/agent/max_tool_rounds';
    public const XML_PATH_MAX_TOOL_EXECUTIONS = 'afd_ai/agent/max_tool_executions';
    public const XML_PATH_MAX_CATEGORY_CALLS = 'afd_ai/agent/max_category_calls';
    public const XML_PATH_BLOCK_DUPLICATE_TOOL_CALLS = 'afd_ai/agent/block_duplicate_tool_calls';
    public const XML_PATH_MAX_OUTPUT_TOKENS = 'afd_ai/agent/max_output_tokens';
    public const XML_PATH_MAX_MODEL_HISTORY_MESSAGES = 'afd_ai/agent/max_model_history_messages';
    public const XML_PATH_MAX_HISTORY_TOKENS = 'afd_ai/agent/max_history_tokens';
    public const XML_PATH_MAX_TOOL_CONTEXT_TOKENS = 'afd_ai/agent/max_tool_context_tokens';
    public const XML_PATH_PROVIDER_STREAM_TIMEOUT_MS = 'afd_ai/agent/provider_stream_timeout_ms';

    // Backward-compatible aliases retained for older integrations/tests.
    public const XML_PATH_AGENT_MAX_TOOL_ROUNDS = self::XML_PATH_MAX_TOOL_ROUNDS;
    public const XML_PATH_AGENT_MAX_TOOL_EXECUTIONS = self::XML_PATH_MAX_TOOL_EXECUTIONS;
    public const XML_PATH_AGENT_MAX_CATEGORY_CALLS = self::XML_PATH_MAX_CATEGORY_CALLS;
    public const XML_PATH_AGENT_BLOCK_DUPLICATES = self::XML_PATH_BLOCK_DUPLICATE_TOOL_CALLS;
    public const XML_PATH_AGENT_MAX_OUTPUT_TOKENS = self::XML_PATH_MAX_OUTPUT_TOKENS;
    public const XML_PATH_AGENT_MAX_HISTORY = self::XML_PATH_MAX_MODEL_HISTORY_MESSAGES;
    public const XML_PATH_AGENT_MAX_HISTORY_TOKENS = self::XML_PATH_MAX_HISTORY_TOKENS;
    public const XML_PATH_AGENT_MAX_TOOL_CONTEXT_TOKENS = self::XML_PATH_MAX_TOOL_CONTEXT_TOKENS;
    public const XML_PATH_AGENT_STREAM_TIMEOUT_MS = self::XML_PATH_PROVIDER_STREAM_TIMEOUT_MS;
    public const XML_PATH_GEMINI_MODEL = self::XML_PATH_MODEL;
    public const XML_PATH_GEMINI_GROUNDING_MODEL = 'afd_ai/gemini/grounding_model';
    public const XML_PATH_CAPACITY_QUEUE_DEPTH = self::XML_PATH_QUEUE_DEPTH;
    public const XML_PATH_CAPACITY_MODEL_LEASE_MS = self::XML_PATH_MODEL_LEASE_MS;
    public const XML_PATH_ATTACHMENT_MAX_IMAGE_BYTES = 'afd_ai/attachments/max_image_bytes';
    public const XML_PATH_ATTACHMENT_MAX_IMAGES = 'afd_ai/attachments/max_images_per_message';
    public const XML_PATH_ATTACHMENT_MAX_TOTAL_BYTES = 'afd_ai/attachments/max_total_image_bytes';
    public const XML_PATH_ATTACHMENT_MAX_TOTAL_ENCODED_BYTES = 'afd_ai/attachments/max_total_encoded_bytes';
    public const XML_PATH_ATTACHMENT_MAX_TOTAL_PIXELS = 'afd_ai/attachments/max_total_pixels';
    public const XML_PATH_ATTACHMENT_VISION_CONCURRENCY = 'afd_ai/attachments/vision_concurrency';
    public const XML_PATH_ATTACHMENT_MAX_OWNER_STORAGE_BYTES = 'afd_ai/attachments/max_owner_storage_bytes';

    public const XML_PATH_VOICE_LIVE_ENABLED = 'afd_ai/voice/live_enabled';
    public const XML_PATH_VOICE_LIVE_MODEL = 'afd_ai/voice/live_model';
    public const XML_PATH_VOICE_LIVE_MAX_SESSIONS_PER_MINUTE = 'afd_ai/voice/live_max_sessions_per_minute';
    public const XML_PATH_VOICE_LIVE_MAX_DURATION_SECONDS = 'afd_ai/voice/live_max_duration_seconds';
    public const XML_PATH_VOICE_MAX_DURATION_SECONDS = 'afd_ai/voice/max_duration_seconds';
    public const XML_PATH_VOICE_MAX_AUDIO_BYTES = 'afd_ai/voice/max_audio_bytes';
    public const XML_PATH_VOICE_REQUESTS_PER_MINUTE = 'afd_ai/voice/requests_per_minute';
    public const XML_PATH_VOICE_MAX_CONCURRENT_PER_IDENTITY = 'afd_ai/voice/max_concurrent_per_identity';
    public const XML_PATH_VOICE_TIMEOUT_MS = 'afd_ai/voice/timeout_ms';

    public const XML_PATH_KNOWLEDGE_ENABLED = 'afd_ai/knowledge/enabled';
    public const XML_PATH_SUPPORT_ENABLED = 'afd_ai/support/enabled';
    public const XML_PATH_SUPPORT_RECIPIENT_EMAIL = 'afd_ai/support/recipient_email';

    public const XML_PATH_CONVERSATION_RETENTION_DAYS = 'afd_ai/privacy/conversation_retention_days';
    public const XML_PATH_RESOLVED_CASE_RETENTION_DAYS = 'afd_ai/privacy/resolved_case_retention_days';
    public const XML_PATH_ANALYTICS_RETENTION_DAYS = 'afd_ai/privacy/analytics_event_retention_days';
    public const XML_PATH_GUARDRAIL_AUDIT_RETENTION_DAYS = 'afd_ai/privacy/guardrail_audit_retention_days';

    public const XML_PATH_MAGENTO_CONSUMER_KEY = 'afd_ai/general/magento_consumer_key';
    public const XML_PATH_MAGENTO_CONSUMER_SECRET = 'afd_ai/general/magento_consumer_secret';
    public const XML_PATH_MAGENTO_ACCESS_TOKEN = 'afd_ai/general/magento_access_token';
    public const XML_PATH_MAGENTO_ACCESS_TOKEN_SECRET = 'afd_ai/general/magento_access_token_secret';

    public const XML_PATH_NODE_SYNC_SECRET = 'afd_ai/general/node_sync_secret';
    public const XML_PATH_WS_TICKET_SECRET = 'afd_ai/general/ws_ticket_secret';
    public const XML_PATH_NODE_SYNC_STATUS = 'afd_ai/general/node_sync_status';

    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly EncryptorInterface $encryptor,
        private readonly ProviderRepositoryInterface $providerRepository,
        private readonly GatewaySecretManager $gatewaySecretManager,
        private readonly LoggerInterface $logger
    ) {}

    public function isEnabled(?int $storeId = null): bool
    {
        return $this->scopeConfig->isSetFlag(self::XML_PATH_ENABLED, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function isGuestHistoryPersistenceEnabled(?int $storeId = null): bool
    {
        return $this->scopeConfig->isSetFlag(self::XML_PATH_PERSIST_GUEST_HISTORY, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function getChatServerUrl(?int $storeId = null): string
    {
        $configured = trim((string)$this->scopeConfig->getValue(self::XML_PATH_CHAT_SERVER_URL, ScopeInterface::SCOPE_STORE, $storeId));
        if ($configured !== '') {
            return rtrim($configured, '/') . '/';
        }

        $baseUrl = rtrim($this->getMagentoBaseUrl($storeId), '/');
        if ($baseUrl === '') {
            return '';
        }
        $scheme = str_starts_with($baseUrl, 'https://') ? 'wss://' : 'ws://';
        $hostPath = preg_replace('#^https?://#i', '', $baseUrl);
        return $scheme . $hostPath . '/ai-gateway/';
    }

    public function isCouponSharingAllowed(?int $storeId = null): bool
    {
        return $this->scopeConfig->isSetFlag(self::XML_PATH_EXPOSE_COUPON_CODES, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function getProviderCode(?int $storeId = null): string
    {
        return trim((string)$this->scopeConfig->getValue(self::XML_PATH_PROVIDER, ScopeInterface::SCOPE_STORE, $storeId));
    }

    public function getProvider(?int $storeId = null): string
    {
        return $this->getProviderCode($storeId);
    }

    public function getActiveProviderEntity(?int $storeId = null): ?ProviderInterface
    {
        $code = $this->getProviderCode($storeId);
        if ($code === '') {
            $list = $this->providerRepository->getList(true);
            return !empty($list) ? reset($list) : null;
        }

        try {
            return $this->providerRepository->getByCode($code);
        } catch (\Throwable) {
            // A configured provider code is an explicit administrator choice.
            // Do not silently switch to the first active row when that code
            // was removed/deactivated; the sync validator must report the
            // broken selection instead of sending credentials for another
            // provider to Node.
            return null;
        }
    }

    public function getModel(?int $storeId = null): string
    {
        $configuredModel = trim((string)$this->scopeConfig->getValue(self::XML_PATH_MODEL, ScopeInterface::SCOPE_STORE, $storeId));
        $provider = $this->getActiveProviderEntity($storeId);
        if ($provider) {
            $models = $provider->getModelsList();
            // The model field is shared with older installations and may
            // still contain a model from a previously selected provider.
            // Never send that stale model to the newly selected provider.
            if ($configuredModel !== '' && (empty($models) || $this->providerContainsModel($models, $configuredModel))) {
                return $configuredModel;
            }
            if (!empty($models) && !empty($models[0]['id'])) {
                return (string)$models[0]['id'];
            }
        }

        if ($configuredModel !== '') {
            return $configuredModel;
        }

        return 'default-model';
    }

    /**
     * The model registry, not a provider-name heuristic, is authoritative for
     * reasoning capability. This mirrors Zcode's model metadata contract so a
     * control is never shown for a model that did not opt into it.
     *
     * @return array<string, mixed>
     */
    public function getSelectedModelMetadata(?int $storeId = null): array
    {
        $provider = $this->getActiveProviderEntity($storeId);
        if (!$provider) {
            return [];
        }

        $modelId = $this->getModel($storeId);
        foreach ($provider->getModelsList() as $model) {
            if (is_array($model) && trim((string)($model['id'] ?? '')) === $modelId) {
                return $model;
            }
        }

        return [];
    }

    /**
     * Model capabilities are the single source of truth for customer-facing
     * media controls. Legacy fields are read only to make existing provider
     * rows safe until they are saved once through the new model editor.
     *
     * @return array{image_generation: bool, video_generation: bool, voice_dictation: bool}
     */
    public function getSelectedModelCapabilities(?int $storeId = null): array
    {
        $model = $this->getSelectedModelMetadata($storeId);
        $capabilities = is_array($model['capabilities'] ?? null) ? $model['capabilities'] : [];
        $legacyImageEnabled = $this->modelCapabilityFlag(
            $model['supports_images'] ?? $model['supportsImages'] ?? null,
            false
        );

        return [
            'image_generation' => $this->modelCapabilityFlag(
                $capabilities['image_generation'] ?? $capabilities['create_edit_image'] ?? ($legacyImageEnabled ? true : null),
                true
            ),
            'video_generation' => $this->modelCapabilityFlag(
                $capabilities['video_generation'] ?? $capabilities['create_edit_video'] ?? null,
                false
            ),
            'voice_dictation' => $this->modelCapabilityFlag(
                $capabilities['voice_dictation'] ?? $capabilities['voice'] ?? null,
                false
            ),
        ];
    }

    /** @return array<int, string> */
    public function getAvailableThoughtLevels(?int $storeId = null): array
    {
        $model = $this->getSelectedModelMetadata($storeId);
        if (empty($model['reasoning_enabled'])) {
            return [];
        }

        $levels = $model['reasoning_levels'] ?? $model['thought_levels'] ?? [];
        if (!is_array($levels)) {
            $levels = [];
        }

        $allowed = ['low', 'medium', 'high', 'xhigh'];
        $normalized = [];
        foreach ($levels as $level) {
            $value = strtolower(trim((string)$level));
            if (in_array($value, $allowed, true) && !in_array($value, $normalized, true)) {
                $normalized[] = $value;
            }
        }

        // Existing providers that already declared reasoning support remain
        // usable during migration without a second required metadata edit.
        return $normalized ?: $allowed;
    }

    public function getThoughtLevel(?int $storeId = null): string
    {
        $available = $this->getAvailableThoughtLevels($storeId);
        if ($available === []) {
            return '';
        }

        $configured = strtolower(trim((string)$this->scopeConfig->getValue(
            self::XML_PATH_THOUGHT_LEVEL,
            ScopeInterface::SCOPE_STORE,
            $storeId
        )));
        if (in_array($configured, $available, true)) {
            return $configured;
        }

        $default = strtolower(trim((string)(
            $this->getSelectedModelMetadata($storeId)['reasoning_default_level'] ?? ''
        )));
        return in_array($default, $available, true) ? $default : $available[0];
    }

    /** @param array<int, array<string, mixed>> $models */
    private function providerContainsModel(array $models, string $modelId): bool
    {
        foreach ($models as $model) {
            if (is_array($model) && trim((string)($model['id'] ?? '')) === $modelId) {
                return true;
            }
        }
        return false;
    }

    private function modelCapabilityFlag(mixed $value, bool $fallback): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return (int)$value === 1;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return false;
            }
        }
        return $fallback;
    }

    private function getSelectedModelMaxOutputTokens(?int $storeId = null): ?int
    {
        $model = $this->getSelectedModelMetadata($storeId);
        $configured = array_key_exists('max_output_tokens_configured', $model)
            ? $this->modelCapabilityFlag($model['max_output_tokens_configured'], false)
            : isset($model['max_output_tokens']) && trim((string)$model['max_output_tokens']) !== '';
        if (!$configured || !isset($model['max_output_tokens'])) {
            return null;
        }

        $value = (int)$model['max_output_tokens'];
        return $value >= 256 && $value <= 1000000 ? $value : null;
    }

    public function getGroundingModel(?int $storeId = null): string
    {
        $grounding = trim((string)$this->scopeConfig->getValue(
            self::XML_PATH_GEMINI_GROUNDING_MODEL,
            ScopeInterface::SCOPE_STORE,
            $storeId
        ));
        if ($grounding !== '') {
            return $grounding;
        }
        return $this->getModel($storeId);
    }

    public function getApiKey(?int $storeId = null): string
    {
        $provider = $this->getActiveProviderEntity($storeId);
        if (!$provider) {
            return '';
        }

        $rawKey = $provider->getApiKey();
        if (!$rawKey) {
            return '';
        }

        try {
            $decrypted = $this->encryptor->decrypt($rawKey);
            return $this->isSafeProviderText($decrypted)
                ? $decrypted
                : ($this->isPlaintextProviderKey($rawKey) ? $rawKey : '');
        } catch (\Throwable) {
            return $this->isPlaintextProviderKey($rawKey) ? $rawKey : '';
        }
    }

    public function getBaseUrl(?int $storeId = null): string
    {
        $provider = $this->getActiveProviderEntity($storeId);
        return $provider ? (string)$provider->getBaseUrl() : '';
    }

    public function getApiFormat(?int $storeId = null): string
    {
        $provider = $this->getActiveProviderEntity($storeId);
        return $provider ? (string)$provider->getApiFormat() : ProviderInterface::FORMAT_ANTHROPIC_MESSAGES;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public function getAllActiveProvidersConfig(): array
    {
        $result = [];
        $providers = $this->providerRepository->getList(true);
        foreach ($providers as $p) {
            $providerCode = trim((string)$p->getProviderCode());
            if ($providerCode === '') {
                continue;
            }
            $rawKey = $p->getApiKey();
            $decryptedKey = '';
            if ($rawKey) {
                try {
                    $decrypted = $this->encryptor->decrypt($rawKey);
                    $decryptedKey = $this->isSafeProviderText($decrypted)
                        ? $decrypted
                        : ($this->isPlaintextProviderKey($rawKey) ? $rawKey : '');
                } catch (\Throwable) {
                    $decryptedKey = $this->isPlaintextProviderKey($rawKey) ? $rawKey : '';
                }
            }

            $result[$providerCode] = [
                'provider_id' => $p->getProviderId(),
                'name' => $p->getName(),
                'code' => $p->getProviderCode(),
                'base_url' => $p->getBaseUrl(),
                'api_key' => $decryptedKey,
                'api_format' => $p->getApiFormat(),
                'models' => $p->getModelsList(),
                'is_active' => $p->getIsActive()
            ];
        }
        return $result;
    }

    public function getMagentoBaseUrl(?int $storeId = null): string
    {
        $secure = $this->scopeConfig->isSetFlag('web/secure/use_in_adminhtml', ScopeInterface::SCOPE_STORE, $storeId)
            || $this->scopeConfig->isSetFlag('web/secure/use_in_frontend', ScopeInterface::SCOPE_STORE, $storeId);
        $path = $secure ? self::XML_PATH_MAGENTO_SECURE_BASE_URL : self::XML_PATH_MAGENTO_UNSECURE_BASE_URL;
        $baseUrl = trim((string)$this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId));
        if ($baseUrl === '' && $path !== self::XML_PATH_MAGENTO_SECURE_BASE_URL) {
            $baseUrl = trim((string)$this->scopeConfig->getValue(
                self::XML_PATH_MAGENTO_SECURE_BASE_URL,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ));
        }
        return $baseUrl;
    }

    /**
     * Stable, non-secret identity for this Magento installation.
     *
     * It is derived from the default-scope base URL so all store views and
     * websites in one installation share a tenant while separate Magento
     * installations naturally receive isolated Node configuration buckets.
     */
    public function getTenantId(): string
    {
        $baseUrl = trim($this->getMagentoBaseUrl(0));
        if ($baseUrl === '') {
            return '';
        }

        $parts = parse_url($baseUrl);
        if (!is_array($parts) || empty($parts['host'])) {
            return '';
        }

        $scheme = strtolower((string)($parts['scheme'] ?? 'https'));
        $host = strtolower((string)$parts['host']);
        $port = isset($parts['port']) ? ':' . (int)$parts['port'] : '';
        $path = rtrim((string)($parts['path'] ?? ''), '/');

        return hash('sha256', $scheme . '://' . $host . $port . $path);
    }

    private function isSafeProviderText(?string $value): bool
    {
        return is_string($value)
            && $value !== ''
            && mb_check_encoding($value, 'UTF-8')
            && !preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value);
    }

    private function isPlaintextProviderKey(?string $value): bool
    {
        return $this->isSafeProviderText($value)
            && !preg_match('/^\d+:\d+:/', (string)$value);
    }

    public function getAgentConfig(?int $storeId = null): array
    {
        $modelMaxOutputTokens = $this->getSelectedModelMaxOutputTokens($storeId);
        return [
            'max_tool_rounds' => max(1, min(12, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_TOOL_ROUNDS, ScopeInterface::SCOPE_STORE, $storeId))),
            'max_tool_executions' => max(1, min(30, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_TOOL_EXECUTIONS, ScopeInterface::SCOPE_STORE, $storeId))),
            'max_category_calls' => max(1, min(10, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_CATEGORY_CALLS, ScopeInterface::SCOPE_STORE, $storeId))),
            'block_duplicate_tool_calls' => $this->scopeConfig->isSetFlag(self::XML_PATH_BLOCK_DUPLICATE_TOOL_CALLS, ScopeInterface::SCOPE_STORE, $storeId),
            'max_output_tokens' => $modelMaxOutputTokens ?? max(256, min(1000000, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_OUTPUT_TOKENS, ScopeInterface::SCOPE_STORE, $storeId))),
            'max_model_history_messages' => max(4, min(40, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_MODEL_HISTORY_MESSAGES, ScopeInterface::SCOPE_STORE, $storeId))),
            'max_history_tokens' => max(512, min(64000, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_HISTORY_TOKENS, ScopeInterface::SCOPE_STORE, $storeId))),
            'max_tool_context_tokens' => max(256, min(24000, (int)$this->scopeConfig->getValue(self::XML_PATH_MAX_TOOL_CONTEXT_TOKENS, ScopeInterface::SCOPE_STORE, $storeId))),
            'provider_stream_timeout_ms' => max(10000, min(300000, (int)$this->scopeConfig->getValue(self::XML_PATH_PROVIDER_STREAM_TIMEOUT_MS, ScopeInterface::SCOPE_STORE, $storeId))),
        ];
    }

    public function getImageGenerationConfig(?int $storeId = null): array
    {
        $model = $this->getSelectedModelMetadata($storeId);
        $capabilities = $this->getSelectedModelCapabilities($storeId);
        return [
            'enabled' => $capabilities['image_generation'],
            'transport' => trim((string)($model['image_transport'] ?? '')),
            'model' => trim((string)($model['image_model'] ?? '')),
            'timeout_ms' => max(30000, min(300000, (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_TIMEOUT_MS, ScopeInterface::SCOPE_STORE, $storeId))),
            'customer_per_hour' => (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_CUSTOMER_PER_HOUR, ScopeInterface::SCOPE_STORE, $storeId),
            'customer_per_day' => (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_CUSTOMER_PER_DAY, ScopeInterface::SCOPE_STORE, $storeId),
            'guest_per_hour' => (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_GUEST_PER_HOUR, ScopeInterface::SCOPE_STORE, $storeId),
            'guest_per_day' => (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_GUEST_PER_DAY, ScopeInterface::SCOPE_STORE, $storeId),
            'cooldown_seconds' => (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_COOLDOWN_SECONDS, ScopeInterface::SCOPE_STORE, $storeId),
            'max_concurrent_per_identity' => max(1, min(3, (int)$this->scopeConfig->getValue(self::XML_PATH_IMAGE_MAX_CONCURRENT, ScopeInterface::SCOPE_STORE, $storeId))),
        ];
    }

    public function getFeatureConfig(?int $storeId = null): array
    {
        return [
            'candidate_memory_enabled' => $this->scopeConfig->isSetFlag(self::XML_PATH_FEATURE_CANDIDATE_MEMORY, ScopeInterface::SCOPE_STORE, $storeId),
            'product_advisor_enabled' => $this->scopeConfig->isSetFlag(self::XML_PATH_FEATURE_PRODUCT_ADVISOR, ScopeInterface::SCOPE_STORE, $storeId),
            'proactive_suggestions_enabled' => $this->scopeConfig->isSetFlag(self::XML_PATH_FEATURE_PROACTIVE_SUGGESTIONS, ScopeInterface::SCOPE_STORE, $storeId),
            'analytics_attribution_enabled' => $this->scopeConfig->isSetFlag(self::XML_PATH_FEATURE_ANALYTICS_ATTRIBUTION, ScopeInterface::SCOPE_STORE, $storeId),
            'guardrails_enabled' => $this->scopeConfig->isSetFlag(self::XML_PATH_FEATURE_GUARDRAILS, ScopeInterface::SCOPE_STORE, $storeId),
        ];
    }

    public function getRateLimitConfig(?int $storeId = null): array
    {
        return [
            'messages_per_minute' => max(1, min(120, (int)$this->scopeConfig->getValue(self::XML_PATH_RATE_MESSAGES_PER_MINUTE, ScopeInterface::SCOPE_STORE, $storeId))),
            'product_pages_per_minute' => (int)$this->scopeConfig->getValue(self::XML_PATH_RATE_PRODUCT_PAGES_PER_MINUTE, ScopeInterface::SCOPE_STORE, $storeId),
            'address_updates_per_minute' => (int)$this->scopeConfig->getValue(self::XML_PATH_RATE_ADDRESS_UPDATES_PER_MINUTE, ScopeInterface::SCOPE_STORE, $storeId),
            'address_updates_per_hour' => (int)$this->scopeConfig->getValue(self::XML_PATH_RATE_ADDRESS_UPDATES_PER_HOUR, ScopeInterface::SCOPE_STORE, $storeId),
        ];
    }

    public function getCapacityConfig(?int $storeId = null): array
    {
        return [
            'concurrent_model_requests' => (int)$this->scopeConfig->getValue(self::XML_PATH_CONCURRENT_MODEL_REQUESTS, ScopeInterface::SCOPE_STORE, $storeId),
            'queue_depth' => max(1, min(10000, (int)$this->scopeConfig->getValue(self::XML_PATH_QUEUE_DEPTH, ScopeInterface::SCOPE_STORE, $storeId))),
            'queue_wait_ms' => (int)$this->scopeConfig->getValue(self::XML_PATH_QUEUE_WAIT_MS, ScopeInterface::SCOPE_STORE, $storeId),
            'model_lease_ms' => max(10000, min(600000, (int)$this->scopeConfig->getValue(self::XML_PATH_MODEL_LEASE_MS, ScopeInterface::SCOPE_STORE, $storeId))),
        ];
    }

    public function getAttachmentConfig(?int $storeId = null): array
    {
        return [
            'max_image_bytes' => max(262144, min(16777216, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_image_bytes', ScopeInterface::SCOPE_STORE, $storeId))),
            'max_images_per_message' => max(1, min(4, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_images_per_message', ScopeInterface::SCOPE_STORE, $storeId))),
            'max_total_image_bytes' => max(262144, min(8388608, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_total_image_bytes', ScopeInterface::SCOPE_STORE, $storeId))),
            'max_total_encoded_bytes' => max(524288, min(6291456, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_total_encoded_bytes', ScopeInterface::SCOPE_STORE, $storeId))),
            'max_total_pixels' => max(1000000, min(50000000, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_total_pixels', ScopeInterface::SCOPE_STORE, $storeId))),
            'vision_concurrency' => max(1, min(32, (int)$this->scopeConfig->getValue('afd_ai/attachments/vision_concurrency', ScopeInterface::SCOPE_STORE, $storeId))),
            'cost_units_per_minute' => (int)$this->scopeConfig->getValue('afd_ai/attachments/cost_units_per_minute', ScopeInterface::SCOPE_STORE, $storeId),
            'network_cost_units_per_minute' => (int)$this->scopeConfig->getValue('afd_ai/attachments/network_cost_units_per_minute', ScopeInterface::SCOPE_STORE, $storeId),
            'global_cost_units_per_minute' => (int)$this->scopeConfig->getValue('afd_ai/attachments/global_cost_units_per_minute', ScopeInterface::SCOPE_STORE, $storeId),
            'min_free_bytes' => max(104857600, (int)$this->scopeConfig->getValue('afd_ai/attachments/min_free_bytes', ScopeInterface::SCOPE_STORE, $storeId)),
            'max_owner_storage_bytes' => max(4194304, (int)$this->scopeConfig->getValue('afd_ai/attachments/max_owner_storage_bytes', ScopeInterface::SCOPE_STORE, $storeId)),
            'max_total_storage_bytes' => (int)$this->scopeConfig->getValue('afd_ai/attachments/max_total_storage_bytes', ScopeInterface::SCOPE_STORE, $storeId),
            'orphan_retention_seconds' => max(604800, (int)$this->scopeConfig->getValue('afd_ai/attachments/orphan_retention_seconds', ScopeInterface::SCOPE_STORE, $storeId)),
            'cleanup_dry_run' => $this->scopeConfig->isSetFlag('afd_ai/attachments/cleanup_dry_run', ScopeInterface::SCOPE_STORE, $storeId),
        ];
    }

    public function getVoiceConfig(?int $storeId = null): array
    {
        $provider = $this->getProviderCode($storeId);
        $model = $this->getSelectedModelMetadata($storeId);
        $capabilities = $this->getSelectedModelCapabilities($storeId);
        return [
            'enabled' => $capabilities['voice_dictation'],
            'transcription_model' => trim((string)($model['voice_model'] ?? '')),
            'max_duration_seconds' => (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_MAX_DURATION_SECONDS, ScopeInterface::SCOPE_STORE, $storeId),
            'max_audio_bytes' => (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_MAX_AUDIO_BYTES, ScopeInterface::SCOPE_STORE, $storeId),
            'requests_per_minute' => (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_REQUESTS_PER_MINUTE, ScopeInterface::SCOPE_STORE, $storeId),
            'max_concurrent_per_identity' => (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_MAX_CONCURRENT_PER_IDENTITY, ScopeInterface::SCOPE_STORE, $storeId),
            'timeout_ms' => (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_TIMEOUT_MS, ScopeInterface::SCOPE_STORE, $storeId),
            'live' => [
                // Live Voice additionally requires the per-store live_enabled
                // kill switch so OpenAI Realtime stays off until it is enabled.
                'enabled' => $provider === 'openai'
                    && $capabilities['voice_dictation']
                    && $this->scopeConfig->isSetFlag(self::XML_PATH_VOICE_LIVE_ENABLED, ScopeInterface::SCOPE_STORE, $storeId),
                'api_key' => $provider === 'openai'
                    ? trim((string)$this->scopeConfig->getValue('afd_ai/voice/live_api_key', ScopeInterface::SCOPE_STORE, $storeId))
                    : '',
                'model' => $provider === 'openai'
                    ? trim((string)$this->scopeConfig->getValue(self::XML_PATH_VOICE_LIVE_MODEL, ScopeInterface::SCOPE_STORE, $storeId))
                    : '',
                'max_sessions_per_minute' => max(1, min(30, (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_LIVE_MAX_SESSIONS_PER_MINUTE, ScopeInterface::SCOPE_STORE, $storeId))),
                'max_duration_seconds' => max(30, min(1800, (int)$this->scopeConfig->getValue(self::XML_PATH_VOICE_LIVE_MAX_DURATION_SECONDS, ScopeInterface::SCOPE_STORE, $storeId))),
            ],
        ];
    }

    public function getMagentoOauthConfig(?int $storeId = null): array
    {
        return [
            'consumer_key' => $this->scopeConfig->getValue(self::XML_PATH_MAGENTO_CONSUMER_KEY, ScopeInterface::SCOPE_STORE, $storeId),
            'consumer_secret' => $this->scopeConfig->getValue(self::XML_PATH_MAGENTO_CONSUMER_SECRET, ScopeInterface::SCOPE_STORE, $storeId),
            'access_token' => $this->scopeConfig->getValue(self::XML_PATH_MAGENTO_ACCESS_TOKEN, ScopeInterface::SCOPE_STORE, $storeId),
            'access_token_secret' => $this->scopeConfig->getValue(self::XML_PATH_MAGENTO_ACCESS_TOKEN_SECRET, ScopeInterface::SCOPE_STORE, $storeId),
        ];
    }

    /** Bounded telemetry retention; 0 keeps the configured fallback of each cleaner. */
    public function getAnalyticsRetentionDays(): int
    {
        return max(30, min(3650, (int)$this->scopeConfig->getValue(
            self::XML_PATH_ANALYTICS_RETENTION_DAYS,
            ScopeConfigInterface::SCOPE_TYPE_DEFAULT
        )));
    }

    public function getGuardrailAuditRetentionDays(): int
    {
        return max(30, min(3650, (int)$this->scopeConfig->getValue(
            self::XML_PATH_GUARDRAIL_AUDIT_RETENTION_DAYS,
            ScopeConfigInterface::SCOPE_TYPE_DEFAULT
        )));
    }

    public function getNodeSyncSecret(): string
    {
        return (string)$this->gatewaySecretManager->getNodeSyncSecret();
    }

    public function getWsTicketSecret(): string
    {
        return (string)$this->gatewaySecretManager->getWebSocketTicketSecret();
    }

    public function getNodeSyncStatus(): string
    {
        return (string)$this->scopeConfig->getValue(
            self::XML_PATH_NODE_SYNC_STATUS,
            ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
            0
        );
    }

    public function getWebSocketTicketSecret(): string
    {
        return (string)$this->gatewaySecretManager->getWebSocketTicketSecret();
    }

    public function canExposeCouponCodes(?int $storeId = null): bool
    {
        // Single canonical reader for the coupon-sharing toggle so admin saves,
        // defaults, and CommerceTool enforcement all resolve afd_ai/features/expose_coupon_codes.
        return $this->isCouponSharingAllowed($storeId);
    }

}
