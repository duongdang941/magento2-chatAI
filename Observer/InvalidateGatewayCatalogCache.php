<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Gateway\InternalRequestSigner;
use Afd\AI\Model\Gateway\GatewayTlsConfigurator;
use Magento\Framework\App\CacheInterface;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\HTTP\Client\CurlFactory;
use Magento\Framework\Serialize\Serializer\Json;
use Psr\Log\LoggerInterface;

/**
 * Invalidates the gateway's catalogue cache version after Magento changes
 * product/category/price data. A short debounce prevents admin bulk updates
 * from producing one network request per entity.
 */
class InvalidateGatewayCatalogCache implements ObserverInterface
{
    private const DEBOUNCE_KEY = 'afd_ai_catalog_gateway_invalidation';

    public function __construct(
        private readonly AiConfig $config,
        private readonly CacheInterface $cache,
        private readonly CurlFactory $curlFactory,
        private readonly Json $json,
        private readonly LoggerInterface $logger,
        private readonly InternalRequestSigner $requestSigner,
        private readonly GatewayTlsConfigurator $gatewayTlsConfigurator
    ) {
    }

    public function execute(Observer $observer): void
    {
        if ($this->cache->load(self::DEBOUNCE_KEY) !== false) {
            return;
        }
        $this->cache->save('1', self::DEBOUNCE_KEY, [], 2);

        $secret = $this->config->getNodeSyncSecret();
        $url = $this->toHttpUrl((string)$this->config->getChatServerUrl());
        if (strlen($secret) < 32 || $url === '') {
            return;
        }

        $body = $this->json->serialize([
            'version' => 1,
            'event_id' => bin2hex(random_bytes(16)),
        ]);
        $timestamp = (string)time();
        try {
            $curl = $this->curlFactory->create();
            $this->gatewayTlsConfigurator->configure($curl, $url);
            $curl->setTimeout(3);
            $curl->addHeader('Content-Type', 'application/json');
            $curl->addHeader('X-Afd-AI-Timestamp', $timestamp);
            $curl->addHeader(
                'X-Afd-AI-Signature',
                $this->requestSigner->signature($secret, $timestamp, 'POST', '/internal/catalog-invalidate', $body)
            );
            $curl->post(rtrim($url, '/') . '/internal/catalog-invalidate', $body);
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI could not invalidate the gateway catalogue cache.', [
                'exception' => $exception,
            ]);
        }
    }

    private function toHttpUrl(string $url): string
    {
        $url = trim($url);
        if (str_starts_with($url, 'wss://')) return 'https://' . substr($url, 6);
        if (str_starts_with($url, 'ws://')) return 'http://' . substr($url, 5);
        return preg_match('#^https?://#', $url) ? $url : '';
    }
}
