<?php
declare(strict_types=1);

namespace Afd\AI\Model\Provider;

use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Model\ProviderApiKeyNormalizer;
use Magento\Framework\HTTP\Client\Curl;

/** Performs a bounded, admin-only connectivity probe without exposing bodies. */
class ProviderHealthChecker
{
    public function __construct(
        private readonly Curl $curl,
        private readonly ProviderApiKeyNormalizer $apiKeyNormalizer,
        private readonly ProviderConfigurationValidator $validator
    ) {
    }

    /** @return array{success:bool,status:int,latency_ms:int,message:string} */
    public function check(ProviderInterface $provider): array
    {
        try {
            $this->validator->validateEndpoint((string)$provider->getBaseUrl());
        } catch (\Throwable $exception) {
            return ['success' => false, 'status' => 0, 'latency_ms' => 0, 'message' => $exception->getMessage()];
        }

        $baseUrl = rtrim((string)$provider->getBaseUrl(), '/');
        $endpoint = preg_replace('~/v1/(?:messages|chat/completions|responses)$~i', '/v1/models', $baseUrl);
        $endpoint = is_string($endpoint) ? $endpoint : $baseUrl;
        if (!str_ends_with(strtolower($endpoint), '/models')) {
            $endpoint .= str_ends_with($endpoint, '/v1') ? '/models' : '/v1/models';
        }

        $apiKey = $this->apiKeyNormalizer->forDisplay($provider->getApiKey());
        $format = (string)$provider->getApiFormat();
        $startedAt = microtime(true);
        try {
            // Curl is shared by Magento's object manager; do not leak an
            // Authorization header from a previous provider probe.
            $this->curl->setHeaders([]);
            $this->curl->removeCookies();
            $this->curl->setTimeout(5);
            $this->curl->setOption(CURLOPT_CONNECTTIMEOUT, 3);
            $this->curl->addHeader('Accept', 'application/json');
            if ($apiKey !== '') {
                $this->curl->addHeader(
                    $format === ProviderInterface::FORMAT_ANTHROPIC_MESSAGES ? 'x-api-key' : 'Authorization',
                    $format === ProviderInterface::FORMAT_ANTHROPIC_MESSAGES ? $apiKey : 'Bearer ' . $apiKey
                );
            }
            if ($format === ProviderInterface::FORMAT_ANTHROPIC_MESSAGES) {
                $this->curl->addHeader('anthropic-version', '2023-06-01');
            }
            $this->curl->get($endpoint);
            $status = (int)$this->curl->getStatus();
            return [
                'success' => $status >= 200 && $status < 300,
                'status' => $status,
                'latency_ms' => max(0, (int)round((microtime(true) - $startedAt) * 1000)),
                'message' => $status >= 200 && $status < 300
                    ? __('Provider endpoint is reachable.')
                    : __('Provider returned HTTP %1.', $status ?: 0),
            ];
        } catch (\Throwable) {
            return [
                'success' => false,
                'status' => 0,
                'latency_ms' => max(0, (int)round((microtime(true) - $startedAt) * 1000)),
                'message' => __('Provider endpoint could not be reached.'),
            ];
        }
    }
}
