<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Provider;

use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Model\Provider\ProviderConfigurationValidator;
use Afd\AI\Model\Provider\ProviderHealthChecker;
use Afd\AI\Model\ProviderApiKeyNormalizer;
use Magento\Framework\HTTP\Client\Curl;
use PHPUnit\Framework\TestCase;

class ProviderHealthCheckerTest extends TestCase
{
    public function testChecksNormalizedModelsEndpointWithoutExposingResponseBody(): void
    {
        $provider = $this->provider(
            'https://provider.example/v1/chat/completions',
            ProviderInterface::FORMAT_OPENAI_CHAT_COMPLETIONS,
            'encrypted-key'
        );
        $curl = $this->createMock(Curl::class);
        $curl->expects(self::once())->method('setHeaders')->with([]);
        $curl->expects(self::once())->method('removeCookies');
        $curl->expects(self::once())->method('setTimeout')->with(5);
        $curl->expects(self::once())->method('setOption')->with(CURLOPT_CONNECTTIMEOUT, 3);
        $curl->expects(self::exactly(2))->method('addHeader');
        $curl->expects(self::once())->method('get')->with('https://provider.example/v1/models');
        $curl->expects(self::once())->method('getStatus')->willReturn(200);
        $normalizer = $this->createMock(ProviderApiKeyNormalizer::class);
        $normalizer->expects(self::once())
            ->method('forDisplay')
            ->with('encrypted-key')
            ->willReturn('provider-secret');

        $result = (new ProviderHealthChecker(
            $curl,
            $normalizer,
            new ProviderConfigurationValidator()
        ))->check($provider);

        self::assertTrue($result['success']);
        self::assertSame(200, $result['status']);
        self::assertSame('Provider endpoint is reachable.', (string)$result['message']);
    }

    public function testRejectsUnsafeRemoteEndpointBeforeNetworkRequest(): void
    {
        $provider = $this->provider(
            'http://provider.example/v1',
            ProviderInterface::FORMAT_OPENAI_RESPONSES,
            ''
        );
        $curl = $this->createMock(Curl::class);
        $curl->expects(self::never())->method('get');

        $result = (new ProviderHealthChecker(
            $curl,
            $this->createMock(ProviderApiKeyNormalizer::class),
            new ProviderConfigurationValidator()
        ))->check($provider);

        self::assertFalse($result['success']);
        self::assertSame(0, $result['status']);
        self::assertStringContainsString('HTTPS', (string)$result['message']);
    }

    public function testUsesAnthropicHeadersForAnthropicProvider(): void
    {
        $provider = $this->provider(
            'https://api.anthropic.com',
            ProviderInterface::FORMAT_ANTHROPIC_MESSAGES,
            'encrypted-key'
        );
        $headers = [];
        $curl = $this->createMock(Curl::class);
        $curl->method('addHeader')->willReturnCallback(
            static function (string $name, string $value) use (&$headers): void {
                $headers[$name] = $value;
            }
        );
        $curl->expects(self::once())->method('get')->with('https://api.anthropic.com/v1/models');
        $curl->method('getStatus')->willReturn(401);
        $normalizer = $this->createMock(ProviderApiKeyNormalizer::class);
        $normalizer->method('forDisplay')->willReturn('anthropic-secret');

        $result = (new ProviderHealthChecker(
            $curl,
            $normalizer,
            new ProviderConfigurationValidator()
        ))->check($provider);

        self::assertFalse($result['success']);
        self::assertSame('anthropic-secret', $headers['x-api-key']);
        self::assertSame('2023-06-01', $headers['anthropic-version']);
        self::assertArrayNotHasKey('Authorization', $headers);
    }

    private function provider(string $baseUrl, string $format, string $apiKey): ProviderInterface
    {
        $provider = $this->createMock(ProviderInterface::class);
        $provider->method('getBaseUrl')->willReturn($baseUrl);
        $provider->method('getApiFormat')->willReturn($format);
        $provider->method('getApiKey')->willReturn($apiKey);

        return $provider;
    }
}
