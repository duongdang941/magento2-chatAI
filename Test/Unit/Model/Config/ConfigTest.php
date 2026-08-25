<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Config;

use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\Config\Config;
use Afd\AI\Model\Gateway\GatewaySecretManager;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class ConfigTest extends TestCase
{
    public function testDerivesSameOriginGatewayUrlFromSecureMagentoBaseUrl(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(static function (string $path): string {
            return match ($path) {
                Config::XML_PATH_MAGENTO_SECURE_BASE_URL => 'https://shop.example/store/',
                default => '',
            };
        });
        $config = $this->createConfig($scopeConfig);

        self::assertSame('wss://shop.example/store/ai-gateway/', $config->getChatServerUrl());
    }

    public function testUsesExplicitGatewayUrlWhenOneIsConfigured(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(static function (string $path): string {
            return $path === Config::XML_PATH_CHAT_SERVER_URL ? 'wss://gateway.example/chat' : '';
        });
        $config = $this->createConfig($scopeConfig);

        self::assertSame('wss://gateway.example/chat/', $config->getChatServerUrl());
    }

    public function testRejectsCiphertextThatDecryptsToInvalidUtf8(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => $path === Config::XML_PATH_PROVIDER ? 'gemini' : '0:3:ZW5jcnlwdGVk'
        );
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->method('decrypt')->willReturn("\xFF\xFEbroken");

        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getApiKey')->willReturn('0:3:ZW5jcnlwdGVk');
        $repository = $this->createMock(ProviderRepositoryInterface::class);
        $repository->method('getByCode')->with('gemini')->willReturn($provider);

        self::assertSame('', $this->createConfig($scopeConfig, $encryptor, $repository)->getApiKey());
    }

    public function testBuildsBoundedRuntimeConfigurationForNodeSync(): void
    {
        $values = [
            Config::XML_PATH_AGENT_MAX_TOOL_ROUNDS => '99',
            Config::XML_PATH_AGENT_MAX_TOOL_EXECUTIONS => '18',
            Config::XML_PATH_AGENT_MAX_CATEGORY_CALLS => '0',
            Config::XML_PATH_AGENT_MAX_OUTPUT_TOKENS => '9000',
            Config::XML_PATH_AGENT_MAX_HISTORY => '2',
            Config::XML_PATH_AGENT_MAX_HISTORY_TOKENS => '100',
            Config::XML_PATH_AGENT_MAX_TOOL_CONTEXT_TOKENS => '99999',
            Config::XML_PATH_AGENT_STREAM_TIMEOUT_MS => '5000',
            Config::XML_PATH_IMAGE_TIMEOUT_MS => '500000',
            Config::XML_PATH_IMAGE_CUSTOMER_PER_HOUR => '7',
            Config::XML_PATH_IMAGE_COOLDOWN_SECONDS => '0',
            Config::XML_PATH_IMAGE_MAX_CONCURRENT => '9',
            Config::XML_PATH_RATE_MESSAGES_PER_MINUTE => '500',
            Config::XML_PATH_CAPACITY_QUEUE_DEPTH => '-3',
            Config::XML_PATH_CAPACITY_MODEL_LEASE_MS => '900000',
            Config::XML_PATH_ATTACHMENT_MAX_IMAGE_BYTES => '100',
            Config::XML_PATH_ATTACHMENT_MAX_IMAGES => '99',
            Config::XML_PATH_ATTACHMENT_MAX_TOTAL_BYTES => '99999999',
            Config::XML_PATH_ATTACHMENT_MAX_TOTAL_ENCODED_BYTES => '1',
            Config::XML_PATH_ATTACHMENT_MAX_TOTAL_PIXELS => '999999999',
            Config::XML_PATH_ATTACHMENT_VISION_CONCURRENCY => '0',
            Config::XML_PATH_ATTACHMENT_MAX_OWNER_STORAGE_BYTES => '100',
        ];
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path) => $values[$path] ?? null
        );
        $scopeConfig->method('isSetFlag')->willReturnCallback(
            static fn (string $path): bool => $path === Config::XML_PATH_AGENT_BLOCK_DUPLICATES
        );
        $encryptor = $this->createMock(EncryptorInterface::class);
        $config = $this->createConfig($scopeConfig, $encryptor);

        self::assertSame(12, $config->getAgentConfig()['max_tool_rounds']);
        self::assertSame(18, $config->getAgentConfig()['max_tool_executions']);
        self::assertSame(1, $config->getAgentConfig()['max_category_calls']);
        self::assertSame(9000, $config->getAgentConfig()['max_output_tokens']);
        self::assertSame(4, $config->getAgentConfig()['max_model_history_messages']);
        self::assertSame(512, $config->getAgentConfig()['max_history_tokens']);
        self::assertSame(24000, $config->getAgentConfig()['max_tool_context_tokens']);
        self::assertTrue($config->getAgentConfig()['block_duplicate_tool_calls']);
        self::assertSame(300000, $config->getImageGenerationConfig()['timeout_ms']);
        self::assertSame(7, $config->getImageGenerationConfig()['customer_per_hour']);
        self::assertSame(0, $config->getImageGenerationConfig()['cooldown_seconds']);
        self::assertSame(3, $config->getImageGenerationConfig()['max_concurrent_per_identity']);
        self::assertSame(120, $config->getRateLimitConfig()['messages_per_minute']);
        self::assertSame(1, $config->getCapacityConfig()['queue_depth']);
        self::assertSame(600000, $config->getCapacityConfig()['model_lease_ms']);
        self::assertSame(262144, $config->getAttachmentConfig()['max_image_bytes']);
        self::assertSame(4, $config->getAttachmentConfig()['max_images_per_message']);
        self::assertSame(8388608, $config->getAttachmentConfig()['max_total_image_bytes']);
        self::assertSame(524288, $config->getAttachmentConfig()['max_total_encoded_bytes']);
        self::assertSame(50000000, $config->getAttachmentConfig()['max_total_pixels']);
        self::assertSame(1, $config->getAttachmentConfig()['vision_concurrency']);
        self::assertSame(104857600, $config->getAttachmentConfig()['min_free_bytes']);
        self::assertSame(4194304, $config->getAttachmentConfig()['max_owner_storage_bytes']);
        self::assertSame(604800, $config->getAttachmentConfig()['orphan_retention_seconds']);
        self::assertFalse($config->getAttachmentConfig()['cleanup_dry_run']);
    }

    public function testBuildsGeminiGroundingAndStoreFeatureConfiguration(): void
    {
        $values = [
            Config::XML_PATH_PROVIDER => 'gemini',
            Config::XML_PATH_GEMINI_MODEL => 'gemini-3.1-flash-lite',
            Config::XML_PATH_GEMINI_GROUNDING_MODEL => 'gemini-2.5-flash',
        ];
        $enabledFlags = [
            Config::XML_PATH_FEATURE_CANDIDATE_MEMORY,
            Config::XML_PATH_FEATURE_PRODUCT_ADVISOR,
            Config::XML_PATH_FEATURE_ANALYTICS_ATTRIBUTION,
            Config::XML_PATH_FEATURE_GUARDRAILS,
        ];
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path) => $values[$path] ?? ''
        );
        $scopeConfig->method('isSetFlag')->willReturnCallback(
            static fn (string $path): bool => in_array($path, $enabledFlags, true)
        );
        $config = $this->createConfig($scopeConfig);

        self::assertSame('gemini-2.5-flash', $config->getGroundingModel());
        self::assertSame([
            'candidate_memory_enabled' => true,
            'product_advisor_enabled' => true,
            'proactive_suggestions_enabled' => false,
            'analytics_attribution_enabled' => true,
            'guardrails_enabled' => true,
        ], $config->getFeatureConfig());
    }

    public function testExposesThoughtLevelOnlyForModelThatDeclaresReasoningCapability(): void
    {
        $values = [
            Config::XML_PATH_PROVIDER => 'cockpit-tool',
            Config::XML_PATH_MODEL => 'gpt-5.6-terra',
            Config::XML_PATH_THOUGHT_LEVEL => 'xhigh',
        ];
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path) => $values[$path] ?? ''
        );

        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getModelsList')->willReturn([
            [
                'id' => 'gpt-5.6-terra',
                'reasoning_enabled' => true,
                'reasoning_levels' => ['low', 'medium', 'high'],
                'reasoning_default_level' => 'high',
            ]
        ]);
        $repository = $this->createMock(ProviderRepositoryInterface::class);
        $repository->method('getByCode')->with('cockpit-tool')->willReturn($provider);

        $config = $this->createConfig($scopeConfig, null, $repository);
        self::assertSame(['low', 'medium', 'high'], $config->getAvailableThoughtLevels());
        self::assertSame('high', $config->getThoughtLevel());
    }

    public function testUsesSelectedModelCapabilitiesAndOutputLimitInsteadOfGlobalMediaToggles(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(static function (string $path): string {
            return match ($path) {
                Config::XML_PATH_PROVIDER => 'custom-provider',
                Config::XML_PATH_MODEL => 'media-capable-model',
                Config::XML_PATH_MAX_OUTPUT_TOKENS => '2048',
                default => '',
            };
        });

        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getModelsList')->willReturn([[
            'id' => 'media-capable-model',
            'max_output_tokens' => 128000,
            'max_output_tokens_configured' => true,
            'capabilities' => [
                'image_generation' => true,
                'video_generation' => false,
                'voice_dictation' => true,
            ],
            'voice_model' => 'gpt-4o-mini-transcribe',
        ]]);
        $repository = $this->createMock(ProviderRepositoryInterface::class);
        $repository->method('getByCode')->with('custom-provider')->willReturn($provider);

        $config = $this->createConfig($scopeConfig, null, $repository);

        self::assertSame([
            'image_generation' => true,
            'video_generation' => false,
            'voice_dictation' => true,
        ], $config->getSelectedModelCapabilities());
        self::assertSame(128000, $config->getAgentConfig()['max_output_tokens']);
        self::assertTrue($config->getImageGenerationConfig()['enabled']);
        self::assertTrue($config->getVoiceConfig()['enabled']);
        self::assertSame('gpt-4o-mini-transcribe', $config->getVoiceConfig()['transcription_model']);
    }

    public function testMigratesLegacyImageSwitchToTheNewImageOnDefault(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(static function (string $path): string {
            return match ($path) {
                Config::XML_PATH_PROVIDER => 'legacy-provider',
                Config::XML_PATH_MODEL => 'legacy-model',
                default => '',
            };
        });

        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getModelsList')->willReturn([[
            'id' => 'legacy-model',
            // This old field was backed by a global Admin toggle and did
            // not represent an intentional per-model capability choice.
            'supports_images' => false,
        ]]);
        $repository = $this->createMock(ProviderRepositoryInterface::class);
        $repository->method('getByCode')->with('legacy-provider')->willReturn($provider);

        $config = $this->createConfig($scopeConfig, null, $repository);

        self::assertTrue($config->getSelectedModelCapabilities()['image_generation']);
        self::assertFalse($config->getSelectedModelCapabilities()['voice_dictation']);
    }

    private function createConfig(
        ScopeConfigInterface $scopeConfig,
        ?EncryptorInterface $encryptor = null,
        ?ProviderRepositoryInterface $providerRepository = null
    ): Config {
        return new Config(
            $scopeConfig,
            $encryptor ?? $this->createMock(EncryptorInterface::class),
            $providerRepository ?? $this->createMock(ProviderRepositoryInterface::class),
            $this->createMock(GatewaySecretManager::class),
            $this->createMock(LoggerInterface::class)
        );
    }
}
