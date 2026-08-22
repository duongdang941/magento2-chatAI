<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Config;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\Config\Config;
use Afd\AI\Model\Gateway\GatewaySecretManager;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class LiveVoiceProviderConfigTest extends TestCase
{
    public function testLiveVoiceIsDisabledWhenGeminiIsTheSelectedProvider(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => $path === Config::XML_PATH_PROVIDER ? 'gemini' : ''
        );
        $scopeConfig->method('isSetFlag')->willReturn(true);

        $config = $this->createConfig($scopeConfig);

        self::assertFalse($config->getVoiceConfig()['live']['enabled']);
        self::assertSame('', $config->getVoiceConfig()['live']['api_key']);
        self::assertSame('', $config->getVoiceConfig()['live']['model']);
    }

    public function testGeminiUsesItsDedicatedVoiceModelSetting(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => match ($path) {
                Config::XML_PATH_PROVIDER => 'gemini',
                Config::XML_PATH_VOICE_GEMINI_MODEL => 'gemini-2.5-flash',
                default => '',
            }
        );
        $scopeConfig->method('isSetFlag')->willReturn(false);

        $config = $this->createConfig($scopeConfig);

        self::assertSame('gemini-2.5-flash', $config->getVoiceConfig()['transcription_model']);
    }

    public function testLiveVoiceUsesItsSettingWhenOpenAiIsTheSelectedProvider(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => $path === Config::XML_PATH_PROVIDER ? 'openai' : ''
        );
        $scopeConfig->method('isSetFlag')->willReturn(true);

        $config = $this->createConfig($scopeConfig);

        self::assertTrue($config->getVoiceConfig()['live']['enabled']);
    }

    private function createConfig(ScopeConfigInterface $scopeConfig): Config
    {
        return new Config(
            $scopeConfig,
            $this->createMock(EncryptorInterface::class),
            $this->createMock(ProviderRepositoryInterface::class),
            $this->createMock(GatewaySecretManager::class),
            $this->createMock(LoggerInterface::class)
        );
    }
}
