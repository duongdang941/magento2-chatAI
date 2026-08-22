<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Provider;

use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Model\Provider\ProviderConfigurationValidator;
use Magento\Framework\Exception\LocalizedException;
use PHPUnit\Framework\TestCase;

class ProviderConfigurationValidatorTest extends TestCase
{
    public function testRejectsRemoteHttpEndpoint(): void
    {
        $provider = $this->provider('http://provider.example/v1');
        $this->expectException(LocalizedException::class);
        (new ProviderConfigurationValidator())->validate($provider);
    }

    public function testRejectsDuplicateModelIds(): void
    {
        $provider = $this->provider('https://provider.example/v1', [
            ['id' => 'model-a', 'context_window' => 10000, 'max_output_tokens' => 4096],
            ['id' => 'model-a', 'context_window' => 10000, 'max_output_tokens' => 4096],
        ]);
        $this->expectException(LocalizedException::class);
        (new ProviderConfigurationValidator())->validate($provider);
    }

    public function testAcceptsLoopbackDevelopmentEndpoint(): void
    {
        $provider = $this->provider('http://127.0.0.1:49998/v1');
        (new ProviderConfigurationValidator())->validate($provider);
        self::assertTrue(true);
    }

    public function testAcceptsModelWithoutMaximumOutputLimit(): void
    {
        $provider = $this->provider('http://127.0.0.1:49998/v1', [[
            'id' => 'model-without-limit',
            'context_window' => 10000,
            'max_output_tokens_configured' => false,
        ]]);

        (new ProviderConfigurationValidator())->validate($provider);
        self::assertTrue(true);
    }

    public function testEndpointValidationDoesNotDependOnLegacyModelMetadata(): void
    {
        $validator = new ProviderConfigurationValidator();
        $validator->validateEndpoint('https://provider.example/v1');
        self::assertTrue(true);
    }

    public function testRejectsPrivateLiteralProviderAddress(): void
    {
        $this->expectException(LocalizedException::class);
        (new ProviderConfigurationValidator())->validateEndpoint('https://169.254.169.254/v1');
    }

    public function testRejectsInjectedImageModelIdentifier(): void
    {
        $provider = $this->provider('https://provider.example/v1', [[
            'id' => 'chat-model',
            'context_window' => 10000,
            'max_output_tokens' => 4096,
            'reasoning_levels' => [],
            'image_model' => 'image-model" autofocus',
        ]]);
        $this->expectException(LocalizedException::class);
        (new ProviderConfigurationValidator())->validate($provider);
    }

    /** @param array<int, array<string, mixed>> $models */
    private function provider(string $baseUrl, array $models = []): ProviderInterface
    {
        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getName')->willReturn('Test provider');
        $provider->method('getProviderCode')->willReturn('test-provider');
        $provider->method('getBaseUrl')->willReturn($baseUrl);
        $provider->method('getApiFormat')->willReturn(ProviderInterface::FORMAT_OPENAI_CHAT_COMPLETIONS);
        $provider->method('getModelsList')->willReturn($models);
        return $provider;
    }
}
