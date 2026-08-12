<?php
namespace Afd\AI\Model\Config;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Store\Model\ScopeInterface;

class Config
{
    const XML_PATH_ENABLED = 'afd_ai/general/enabled';
    const XML_PATH_PERSIST_GUEST_HISTORY = 'afd_ai/general/persist_guest_history';
    const XML_PATH_CHAT_SERVER_URL = 'afd_ai/general/chat_server_url';
    const XML_PATH_EXPOSE_COUPON_CODES = 'afd_ai/general/expose_coupon_codes';
    const XML_PATH_PROVIDER = 'afd_ai/general/provider';
    
    const XML_PATH_GEMINI_API_KEY = 'afd_ai/general/gemini_api_key';
    const XML_PATH_GEMINI_MODEL = 'afd_ai/general/gemini_model';
    
    const XML_PATH_OPENAI_API_KEY = 'afd_ai/general/openai_api_key';
    const XML_PATH_OPENAI_MODEL = 'afd_ai/general/openai_model';
    
    const XML_PATH_OPENROUTER_API_KEY = 'afd_ai/general/openrouter_api_key';
    const XML_PATH_OPENROUTER_MODEL = 'afd_ai/general/openrouter_model';

    const XML_PATH_NINE_ROUTER_API_KEY = 'afd_ai/general/nine_router_api_key';
    const XML_PATH_NINE_ROUTER_BASE_URL = 'afd_ai/general/nine_router_base_url';
    const XML_PATH_NINE_ROUTER_MODEL = 'afd_ai/general/nine_router_model';

    const XML_PATH_COCKPIT_API_KEY = 'afd_ai/general/cockpit_api_key';
    const XML_PATH_COCKPIT_BASE_URL = 'afd_ai/general/cockpit_base_url';
    const XML_PATH_COCKPIT_MODEL = 'afd_ai/general/cockpit_model';
    const XML_PATH_IMAGE_GENERATION_ENABLED = 'afd_ai/general/image_generation_enabled';
    const XML_PATH_COCKPIT_IMAGE_MODEL = 'afd_ai/general/cockpit_image_model';
    const XML_PATH_COCKPIT_IMAGE_SIZE = 'afd_ai/general/cockpit_image_size';
    const XML_PATH_COCKPIT_IMAGE_QUALITY = 'afd_ai/general/cockpit_image_quality';
    const XML_PATH_IMAGE_TIMEOUT_MS = 'afd_ai/image_generation/timeout_ms';
    const XML_PATH_IMAGE_CUSTOMER_PER_HOUR = 'afd_ai/image_generation/customer_per_hour';
    const XML_PATH_IMAGE_CUSTOMER_PER_DAY = 'afd_ai/image_generation/customer_per_day';
    const XML_PATH_IMAGE_GUEST_PER_HOUR = 'afd_ai/image_generation/guest_per_hour';
    const XML_PATH_IMAGE_GUEST_PER_DAY = 'afd_ai/image_generation/guest_per_day';
    const XML_PATH_IMAGE_COOLDOWN_SECONDS = 'afd_ai/image_generation/cooldown_seconds';
    const XML_PATH_IMAGE_MAX_CONCURRENT = 'afd_ai/image_generation/max_concurrent_per_identity';

    const XML_PATH_AGENT_MAX_TOOL_ROUNDS = 'afd_ai/agent/max_tool_rounds';
    const XML_PATH_AGENT_MAX_TOOL_EXECUTIONS = 'afd_ai/agent/max_tool_executions';
    const XML_PATH_AGENT_MAX_CATEGORY_CALLS = 'afd_ai/agent/max_category_calls';
    const XML_PATH_AGENT_BLOCK_DUPLICATES = 'afd_ai/agent/block_duplicate_tool_calls';
    const XML_PATH_AGENT_MAX_OUTPUT_TOKENS = 'afd_ai/agent/max_output_tokens';
    const XML_PATH_AGENT_MAX_HISTORY = 'afd_ai/agent/max_model_history_messages';
    const XML_PATH_AGENT_STREAM_TIMEOUT_MS = 'afd_ai/agent/provider_stream_timeout_ms';

    const XML_PATH_RATE_MESSAGES_PER_MINUTE = 'afd_ai/rate_limits/messages_per_minute';
    const XML_PATH_RATE_PRODUCT_PAGES_PER_MINUTE = 'afd_ai/rate_limits/product_pages_per_minute';
    const XML_PATH_RATE_ADDRESS_UPDATES_PER_MINUTE = 'afd_ai/rate_limits/address_updates_per_minute';
    const XML_PATH_RATE_ADDRESS_UPDATES_PER_HOUR = 'afd_ai/rate_limits/address_updates_per_hour';

    const XML_PATH_CAPACITY_CONCURRENT_REQUESTS = 'afd_ai/capacity/concurrent_model_requests';
    const XML_PATH_CAPACITY_QUEUE_DEPTH = 'afd_ai/capacity/queue_depth';
    const XML_PATH_CAPACITY_QUEUE_WAIT_MS = 'afd_ai/capacity/queue_wait_ms';
    const XML_PATH_CAPACITY_MODEL_LEASE_MS = 'afd_ai/capacity/model_lease_ms';

    const XML_PATH_ATTACHMENT_MAX_IMAGE_BYTES = 'afd_ai/attachments/max_image_bytes';
    const XML_PATH_ATTACHMENT_MAX_IMAGES = 'afd_ai/attachments/max_images_per_message';

    const XML_PATH_VOICE_ENABLED = 'afd_ai/voice/enabled';
    const XML_PATH_VOICE_TRANSCRIPTION_MODEL = 'afd_ai/voice/transcription_model';
    const XML_PATH_VOICE_MAX_DURATION_SECONDS = 'afd_ai/voice/max_duration_seconds';
    const XML_PATH_VOICE_MAX_AUDIO_BYTES = 'afd_ai/voice/max_audio_bytes';
    const XML_PATH_VOICE_REQUESTS_PER_MINUTE = 'afd_ai/voice/requests_per_minute';
    const XML_PATH_VOICE_MAX_CONCURRENT = 'afd_ai/voice/max_concurrent_per_identity';
    const XML_PATH_VOICE_TIMEOUT_MS = 'afd_ai/voice/timeout_ms';
    /**
     * Live Voice intentionally has its own OpenAI credential.  Reusing the
     * storefront chat provider would silently route audio through Cockpit or
     * another OpenAI-compatible API which may not implement Realtime.
     */
    const XML_PATH_VOICE_LIVE_ENABLED = 'afd_ai/voice/live_enabled';
    const XML_PATH_VOICE_LIVE_OPENAI_API_KEY = 'afd_ai/voice/live_openai_api_key';
    const XML_PATH_VOICE_LIVE_MODEL = 'afd_ai/voice/live_model';
    const XML_PATH_VOICE_LIVE_MAX_SESSIONS_PER_MINUTE = 'afd_ai/voice/live_max_sessions_per_minute';
    const XML_PATH_VOICE_LIVE_MAX_DURATION_SECONDS = 'afd_ai/voice/live_max_duration_seconds';

    const XML_PATH_MAGENTO_CONSUMER_KEY = 'afd_ai/general/magento_consumer_key';
    const XML_PATH_MAGENTO_CONSUMER_SECRET = 'afd_ai/general/magento_consumer_secret';
    const XML_PATH_MAGENTO_ACCESS_TOKEN = 'afd_ai/general/magento_access_token';
    const XML_PATH_MAGENTO_ACCESS_TOKEN_SECRET = 'afd_ai/general/magento_access_token_secret';

    /**
     * Shared secret used exclusively to authenticate Magento -> Node config
     * pushes. It is deliberately separate from Magento REST credentials.
     */
    const XML_PATH_NODE_SYNC_SECRET = 'afd_ai/general/node_sync_secret';
    const XML_PATH_WS_TICKET_SECRET = 'afd_ai/general/ws_ticket_secret';
    const XML_PATH_NODE_SYNC_STATUS = 'afd_ai/general/node_sync_status';

    /**
     * @var ScopeConfigInterface
     */
    private $scopeConfig;

    /**
     * @var EncryptorInterface
     */
    private $encryptor;

    /**
     * @param ScopeConfigInterface $scopeConfig
     * @param EncryptorInterface $encryptor
     */
    public function __construct(
        ScopeConfigInterface $scopeConfig,
        EncryptorInterface $encryptor
    ) {
        $this->scopeConfig = $scopeConfig;
        $this->encryptor = $encryptor;
    }

    public function isEnabled($storeId = null)
    {
        return $this->scopeConfig->isSetFlag(self::XML_PATH_ENABLED, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function isGuestHistoryPersistenceEnabled($storeId = null): bool
    {
        return $this->scopeConfig->isSetFlag(
            self::XML_PATH_PERSIST_GUEST_HISTORY,
            ScopeInterface::SCOPE_STORE,
            $storeId
        );
    }

    public function getChatServerUrl($storeId = null)
    {
        return $this->scopeConfig->getValue(self::XML_PATH_CHAT_SERVER_URL, ScopeInterface::SCOPE_STORE, $storeId);
    }

    /**
     * Coupon codes can be partner-, campaign- or one-time-only data. Keep
     * them hidden from the AI unless a merchant deliberately enables this for
     * the current store view.
     */
    public function canExposeCouponCodes($storeId = null): bool
    {
        return $this->scopeConfig->isSetFlag(
            self::XML_PATH_EXPOSE_COUPON_CODES,
            ScopeInterface::SCOPE_STORE,
            $storeId
        );
    }

    public function getProvider($storeId = null)
    {
        return $this->scopeConfig->getValue(self::XML_PATH_PROVIDER, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function getApiKey($storeId = null)
    {
        $provider = $this->getProvider($storeId);
        $path = '';
        $envKey = '';
        
        switch ($provider) {
            case 'gemini':
                $path = self::XML_PATH_GEMINI_API_KEY;
                $envKey = 'GEMINI_API_KEY';
                break;
            case 'openai':
                $path = self::XML_PATH_OPENAI_API_KEY;
                $envKey = 'OPENAI_API_KEY';
                break;
            case 'openrouter':
                $path = self::XML_PATH_OPENROUTER_API_KEY;
                $envKey = 'OPENROUTER_API_KEY';
                break;
            case '9router':
                $path = self::XML_PATH_NINE_ROUTER_API_KEY;
                $envKey = 'NINE_ROUTER_API_KEY';
                break;
            case 'cockpit':
                $path = self::XML_PATH_COCKPIT_API_KEY;
                $envKey = 'COCKPIT_API_KEY';
                break;
        }

        if (!$path) {
            return '';
        }

        $value = $this->getEncryptedValue($path, $storeId);
        if ($value !== '') {
            return $value;
        }

        $environmentValue = $envKey !== '' ? getenv($envKey) : false;
        return is_string($environmentValue) ? $environmentValue : '';
    }

    public function getModel($storeId = null)
    {
        $provider = $this->getProvider($storeId);
        $path = '';
        
        switch ($provider) {
            case 'gemini':
                $path = self::XML_PATH_GEMINI_MODEL;
                break;
            case 'openai':
                $path = self::XML_PATH_OPENAI_MODEL;
                break;
            case 'openrouter':
                $path = self::XML_PATH_OPENROUTER_MODEL;
                break;
            case '9router':
                $path = self::XML_PATH_NINE_ROUTER_MODEL;
                break;
            case 'cockpit':
                $path = self::XML_PATH_COCKPIT_MODEL;
                break;
        }

        if (!$path) {
            return '';
        }

        return $this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId);
    }

    public function getBaseUrl($storeId = null)
    {
        $provider = $this->getProvider($storeId);
        if ($provider === '9router') {
            return (string)$this->scopeConfig->getValue(self::XML_PATH_NINE_ROUTER_BASE_URL, ScopeInterface::SCOPE_STORE, $storeId);
        }

        if ($provider === 'cockpit') {
            return (string)$this->scopeConfig->getValue(self::XML_PATH_COCKPIT_BASE_URL, ScopeInterface::SCOPE_STORE, $storeId);
        }

        return '';
    }

    /**
     * Image generation settings synced from the Magento Admin configuration.
     */
    public function getImageGenerationConfig($storeId = null): array
    {
        return [
            'enabled' => $this->scopeConfig->isSetFlag(
                self::XML_PATH_IMAGE_GENERATION_ENABLED,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'model' => (string)$this->scopeConfig->getValue(
                self::XML_PATH_COCKPIT_IMAGE_MODEL,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'size' => (string)$this->scopeConfig->getValue(
                self::XML_PATH_COCKPIT_IMAGE_SIZE,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'quality' => (string)$this->scopeConfig->getValue(
                self::XML_PATH_COCKPIT_IMAGE_QUALITY,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'timeout_ms' => $this->getIntValue(self::XML_PATH_IMAGE_TIMEOUT_MS, 180000, 30000, 300000, $storeId),
            'customer_per_hour' => $this->getIntValue(self::XML_PATH_IMAGE_CUSTOMER_PER_HOUR, 3, 1, 100, $storeId),
            'customer_per_day' => $this->getIntValue(self::XML_PATH_IMAGE_CUSTOMER_PER_DAY, 10, 1, 500, $storeId),
            'guest_per_hour' => $this->getIntValue(self::XML_PATH_IMAGE_GUEST_PER_HOUR, 2, 1, 50, $storeId),
            'guest_per_day' => $this->getIntValue(self::XML_PATH_IMAGE_GUEST_PER_DAY, 5, 1, 200, $storeId),
            'cooldown_seconds' => $this->getIntValue(self::XML_PATH_IMAGE_COOLDOWN_SECONDS, 60, 0, 3600, $storeId),
            'max_concurrent_per_identity' => $this->getIntValue(self::XML_PATH_IMAGE_MAX_CONCURRENT, 1, 1, 3, $storeId),
        ];
    }

    /**
     * Provider reasoning and tool-use settings synced to the Node gateway.
     */
    public function getAgentConfig($storeId = null): array
    {
        return [
            'max_tool_rounds' => $this->getIntValue(self::XML_PATH_AGENT_MAX_TOOL_ROUNDS, 8, 1, 12, $storeId),
            'max_tool_executions' => $this->getIntValue(self::XML_PATH_AGENT_MAX_TOOL_EXECUTIONS, 15, 1, 30, $storeId),
            'max_category_calls' => $this->getIntValue(self::XML_PATH_AGENT_MAX_CATEGORY_CALLS, 3, 1, 10, $storeId),
            'block_duplicate_tool_calls' => $this->scopeConfig->isSetFlag(
                self::XML_PATH_AGENT_BLOCK_DUPLICATES,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'max_output_tokens' => $this->getIntValue(self::XML_PATH_AGENT_MAX_OUTPUT_TOKENS, 2048, 256, 8192, $storeId),
            'max_model_history_messages' => $this->getIntValue(self::XML_PATH_AGENT_MAX_HISTORY, 20, 4, 40, $storeId),
            'provider_stream_timeout_ms' => $this->getIntValue(self::XML_PATH_AGENT_STREAM_TIMEOUT_MS, 120000, 10000, 300000, $storeId),
        ];
    }

    /**
     * Per-shopper mutation and browsing limits.
     */
    public function getRateLimitConfig($storeId = null): array
    {
        return [
            'messages_per_minute' => $this->getIntValue(self::XML_PATH_RATE_MESSAGES_PER_MINUTE, 15, 1, 120, $storeId),
            'product_pages_per_minute' => $this->getIntValue(self::XML_PATH_RATE_PRODUCT_PAGES_PER_MINUTE, 30, 1, 120, $storeId),
            'address_updates_per_minute' => $this->getIntValue(self::XML_PATH_RATE_ADDRESS_UPDATES_PER_MINUTE, 5, 1, 30, $storeId),
            'address_updates_per_hour' => $this->getIntValue(self::XML_PATH_RATE_ADDRESS_UPDATES_PER_HOUR, 20, 1, 200, $storeId),
        ];
    }

    /**
     * Shared model queue settings for the Node gateway.
     */
    public function getCapacityConfig($storeId = null): array
    {
        return [
            'concurrent_model_requests' => $this->getIntValue(self::XML_PATH_CAPACITY_CONCURRENT_REQUESTS, 32, 1, 1000, $storeId),
            'queue_depth' => $this->getIntValue(self::XML_PATH_CAPACITY_QUEUE_DEPTH, 200, 1, 10000, $storeId),
            'queue_wait_ms' => $this->getIntValue(self::XML_PATH_CAPACITY_QUEUE_WAIT_MS, 30000, 1000, 300000, $storeId),
            'model_lease_ms' => $this->getIntValue(self::XML_PATH_CAPACITY_MODEL_LEASE_MS, 180000, 10000, 600000, $storeId),
        ];
    }

    /**
     * Shopper image-upload limits applied before model admission.
     */
    public function getAttachmentConfig($storeId = null): array
    {
        return [
            'max_image_bytes' => $this->getIntValue(
                self::XML_PATH_ATTACHMENT_MAX_IMAGE_BYTES,
                4194304,
                262144,
                16777216,
                $storeId
            ),
            'max_images_per_message' => $this->getIntValue(
                self::XML_PATH_ATTACHMENT_MAX_IMAGES,
                4,
                1,
                4,
                $storeId
            ),
        ];
    }

    /**
     * Voice is dictation, not an audio message feature. The browser records a
     * short-lived blob, Node transcribes it, and only the shopper-approved
     * transcript can later become part of a conversation.
     */
    public function getVoiceConfig($storeId = null): array
    {
        return [
            'enabled' => $this->scopeConfig->isSetFlag(
                self::XML_PATH_VOICE_ENABLED,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'transcription_model' => (string)$this->scopeConfig->getValue(
                self::XML_PATH_VOICE_TRANSCRIPTION_MODEL,
                ScopeInterface::SCOPE_STORE,
                $storeId
            ),
            'max_duration_seconds' => $this->getIntValue(
                self::XML_PATH_VOICE_MAX_DURATION_SECONDS,
                120,
                5,
                300,
                $storeId
            ),
            'max_audio_bytes' => $this->getIntValue(
                self::XML_PATH_VOICE_MAX_AUDIO_BYTES,
                4194304,
                262144,
                4194304,
                $storeId
            ),
            'requests_per_minute' => $this->getIntValue(
                self::XML_PATH_VOICE_REQUESTS_PER_MINUTE,
                6,
                1,
                30,
                $storeId
            ),
            'max_concurrent_per_identity' => $this->getIntValue(
                self::XML_PATH_VOICE_MAX_CONCURRENT,
                1,
                1,
                2,
                $storeId
            ),
            'timeout_ms' => $this->getIntValue(
                self::XML_PATH_VOICE_TIMEOUT_MS,
                120000,
                10000,
                180000,
                $storeId
            ),
            'live' => [
                'enabled' => $this->scopeConfig->isSetFlag(
                    self::XML_PATH_VOICE_LIVE_ENABLED,
                    ScopeInterface::SCOPE_STORE,
                    $storeId
                ),
                // This is included only in the encrypted Magento → Node
                // snapshot. It is never rendered into storefront JavaScript.
                'api_key' => $this->getEncryptedValue(self::XML_PATH_VOICE_LIVE_OPENAI_API_KEY, $storeId),
                'model' => (string)$this->scopeConfig->getValue(
                    self::XML_PATH_VOICE_LIVE_MODEL,
                    ScopeInterface::SCOPE_STORE,
                    $storeId
                ),
                'max_sessions_per_minute' => $this->getIntValue(
                    self::XML_PATH_VOICE_LIVE_MAX_SESSIONS_PER_MINUTE,
                    3,
                    1,
                    30,
                    $storeId
                ),
                'max_duration_seconds' => $this->getIntValue(
                    self::XML_PATH_VOICE_LIVE_MAX_DURATION_SECONDS,
                    600,
                    30,
                    1800,
                    $storeId
                ),
            ],
        ];
    }

    /**
     * OAuth 1.0 integration credentials used by the Node gateway when it
     * calls Magento service endpoints. All four values are encrypted at rest
     * in Magento and are sent only in an HMAC-authenticated config push.
     */
    public function getMagentoOauthConfig($storeId = null): array
    {
        return [
            'consumer_key' => $this->getEncryptedValue(self::XML_PATH_MAGENTO_CONSUMER_KEY, $storeId),
            'consumer_secret' => $this->getEncryptedValue(self::XML_PATH_MAGENTO_CONSUMER_SECRET, $storeId),
            'access_token' => $this->getEncryptedValue(self::XML_PATH_MAGENTO_ACCESS_TOKEN, $storeId),
            'access_token_secret' => $this->getEncryptedValue(self::XML_PATH_MAGENTO_ACCESS_TOKEN_SECRET, $storeId),
        ];
    }

    /**
     * Return the HMAC secret for the local Node configuration endpoint.
     * The value is saved by Magento's encrypted config backend model.
     */
    public function getNodeSyncSecret($storeId = null): string
    {
        return $this->getEncryptedValue(self::XML_PATH_NODE_SYNC_SECRET, $storeId);
    }

    /**
     * Secret used only to mint browser-to-gateway WebSocket tickets. It is
     * intentionally separate from the Magento-to-Node internal HMAC secret.
     */
    public function getWebSocketTicketSecret($storeId = null): string
    {
        return $this->getEncryptedValue(self::XML_PATH_WS_TICKET_SECRET, $storeId);
    }

    private function getIntValue(
        string $path,
        int $fallback,
        int $minimum,
        int $maximum,
        $storeId = null
    ): int {
        $value = $this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId);
        if (!is_numeric($value)) {
            return $fallback;
        }

        return max($minimum, min((int)$value, $maximum));
    }

    private function getEncryptedValue(string $path, $storeId = null): string
    {
        $value = (string)$this->scopeConfig->getValue(
            $path,
            ScopeInterface::SCOPE_STORE,
            $storeId
        );

        if ($value === '') {
            return '';
        }

        try {
            return (string)$this->encryptor->decrypt($value);
        } catch (\Exception $exception) {
            return '';
        }
    }

    public function getNodeSyncStatus($storeId = null): string
    {
        return (string)$this->scopeConfig->getValue(
            self::XML_PATH_NODE_SYNC_STATUS,
            ScopeInterface::SCOPE_STORE,
            $storeId
        );
    }
}
