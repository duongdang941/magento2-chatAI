<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Config;

use Afd\AI\Model\Config\Config;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;

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
        $config = new Config($scopeConfig, $this->createMock(EncryptorInterface::class));

        self::assertSame('wss://shop.example/store/ai-gateway/', $config->getChatServerUrl());
    }

    public function testUsesExplicitGatewayUrlWhenOneIsConfigured(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(static function (string $path): string {
            return $path === Config::XML_PATH_CHAT_SERVER_URL ? 'wss://gateway.example/chat' : '';
        });
        $config = new Config($scopeConfig, $this->createMock(EncryptorInterface::class));

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

        self::assertSame('', (new Config($scopeConfig, $encryptor))->getApiKey());
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
        ];
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path) => $values[$path] ?? null
        );
        $scopeConfig->method('isSetFlag')->willReturnCallback(
            static fn (string $path): bool => $path === Config::XML_PATH_AGENT_BLOCK_DUPLICATES
        );
        $encryptor = $this->createMock(EncryptorInterface::class);
        $config = new Config($scopeConfig, $encryptor);

        self::assertSame(12, $config->getAgentConfig()['max_tool_rounds']);
        self::assertSame(18, $config->getAgentConfig()['max_tool_executions']);
        self::assertSame(1, $config->getAgentConfig()['max_category_calls']);
        self::assertSame(8192, $config->getAgentConfig()['max_output_tokens']);
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
    }
}
