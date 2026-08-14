<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Config;

use Afd\AI\Model\Config\Config;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;

class LiveVoiceProviderConfigTest extends TestCase
{
    public function testLiveVoiceIsDisabledWhenGeminiIsTheSelectedProvider(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => $path === Config::XML_PATH_PROVIDER ? 'gemini' : ''
        );
        $scopeConfig->method('isSetFlag')->willReturn(true);

        $config = new Config($scopeConfig, $this->createMock(EncryptorInterface::class));

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

        $config = new Config($scopeConfig, $this->createMock(EncryptorInterface::class));

        self::assertSame('gemini-2.5-flash', $config->getVoiceConfig()['transcription_model']);
    }

    public function testLiveVoiceUsesItsSettingWhenOpenAiIsTheSelectedProvider(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')->willReturnCallback(
            static fn (string $path): string => $path === Config::XML_PATH_PROVIDER ? 'openai' : ''
        );
        $scopeConfig->method('isSetFlag')->willReturn(true);

        $config = new Config($scopeConfig, $this->createMock(EncryptorInterface::class));

        self::assertTrue($config->getVoiceConfig()['live']['enabled']);
    }
}
