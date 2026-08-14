<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Gateway\GatewayTlsConfigurator;
use Afd\AI\Model\Gateway\InternalRequestSigner;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\HTTP\Client\Curl;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\Store\Model\StoreManagerInterface;
use Psr\Log\LoggerInterface;

class SyncNodeConfig implements ObserverInterface
{
    private Curl $curl;
    private AiConfig $aiConfig;
    private WriterInterface $configWriter;
    private Json $json;
    private LoggerInterface $logger;
    private StoreManagerInterface $storeManager;
    private InternalRequestSigner $requestSigner;
    private GatewayTlsConfigurator $gatewayTlsConfigurator;

    public function __construct(
        Curl $curl,
        AiConfig $aiConfig,
        WriterInterface $configWriter,
        Json $json,
        LoggerInterface $logger,
        StoreManagerInterface $storeManager,
        InternalRequestSigner $requestSigner,
        GatewayTlsConfigurator $gatewayTlsConfigurator
    ) {
        $this->curl = $curl;
        $this->aiConfig = $aiConfig;
        $this->configWriter = $configWriter;
        $this->json = $json;
        $this->logger = $logger;
        $this->storeManager = $storeManager;
        $this->requestSigner = $requestSigner;
        $this->gatewayTlsConfigurator = $gatewayTlsConfigurator;
    }

    public function execute(Observer $observer): void
    {
        $serverUrl = trim((string)$this->aiConfig->getChatServerUrl());
        if ($serverUrl === '') {
            $this->saveStatus('failed', 'Node server URL is not configured.');
            return;
        }

        $reloadUrl = $this->toHttpUrl($serverUrl);
        if ($reloadUrl === '') {
            $this->saveStatus('failed', 'Node server URL is invalid.');
            return;
        }

        $secret = $this->aiConfig->getNodeSyncSecret();
        if (strlen($secret) < 32) {
            $this->saveStatus('failed', 'Node sync secret is not configured.');
            $this->logger->warning('Afd AI configuration was not pushed because the Node sync secret is too short.');
            return;
        }

        $syncId = bin2hex(random_bytes(16));
        $reloadUrl = rtrim($reloadUrl, '/') . '/internal/config';
        $payload = [
            'version' => 2,
            'sync_id' => $syncId,
            'config' => $this->buildConfigSnapshot(),
        ];
        $body = $this->json->serialize($payload);
        $timestamp = (string)time();
        $signature = $this->requestSigner->signature($secret, $timestamp, 'POST', '/internal/config', $body);

        try {
            $this->curl->setTimeout(5);
            $this->gatewayTlsConfigurator->configure($this->curl);
            $this->curl->addHeader('Accept', 'application/json');
            $this->curl->addHeader('Content-Type', 'application/json');
            $this->curl->addHeader('X-Afd-AI-Timestamp', $timestamp);
            $this->curl->addHeader('X-Afd-AI-Signature', $signature);
            $this->curl->addHeader('X-Afd-AI-Sync-Id', $syncId);
            $this->curl->post($reloadUrl, $body);

            $status = $this->curl->getStatus();
            $response = $this->decodeResponse($this->curl->getBody());
            if ($status < 200 || $status >= 300) {
                $message = trim((string)($response['message'] ?? ''));
                $this->saveStatus(
                    'failed',
                    $message !== '' ? $message : sprintf('Node returned HTTP %d.', $status),
                    $syncId,
                    $status
                );
                $this->logger->warning(sprintf(
                    'Afd AI config push returned HTTP %d for %s',
                    $status,
                    $reloadUrl
                ));
                return;
            }

            if (($response['sync_id'] ?? null) !== $syncId) {
                $this->saveStatus('failed', 'Node returned an invalid synchronization response.', $syncId, $status);
                $this->logger->warning('Afd AI config push returned a response with an unexpected sync ID.');
                return;
            }

            $this->saveStatus(
                'success',
                (string)($response['message'] ?? 'Node accepted the configuration.'),
                $syncId,
                $status,
                (string)($response['provider'] ?? $payload['config']['default']['provider']),
                (string)($response['model'] ?? $payload['config']['default']['model'])
            );
        } catch (\Throwable $error) {
            $this->saveStatus('failed', 'Could not reach the Node service.', $syncId);
            $this->logger->warning(sprintf(
                'Afd AI config push failed for %s: %s',
                $reloadUrl,
                $error->getMessage()
            ));
        }
    }

    /** @return array{default:array<string,mixed>,stores:array<string,array<string,mixed>>} */
    private function buildConfigSnapshot(): array
    {
        $stores = [];
        foreach ($this->storeManager->getStores(true) as $store) {
            if (!(bool)$store->isActive()) {
                continue;
            }
            $stores[(string)$store->getCode()] = $this->buildStoreConfig((int)$store->getId());
        }

        return [
            'default' => $this->buildStoreConfig(null),
            'stores' => $stores,
        ];
    }

    /** @return array<string,mixed> */
    private function buildStoreConfig(?int $storeId): array
    {
        return [
            'enabled' => $this->aiConfig->isEnabled($storeId),
            'persist_guest_history' => $this->aiConfig->isGuestHistoryPersistenceEnabled($storeId),
            'provider' => (string)$this->aiConfig->getProvider($storeId),
            'model' => (string)$this->aiConfig->getModel($storeId),
            'grounding_model' => $this->aiConfig->getGroundingModel($storeId),
            'api_key' => $this->aiConfig->getApiKey($storeId),
            'base_url' => (string)$this->aiConfig->getBaseUrl($storeId),
            'magento_base_url' => $this->aiConfig->getMagentoBaseUrl($storeId),
            'agent' => $this->aiConfig->getAgentConfig($storeId),
            'image_generation' => $this->aiConfig->getImageGenerationConfig($storeId),
            'features' => $this->aiConfig->getFeatureConfig($storeId),
            'rate_limits' => $this->aiConfig->getRateLimitConfig($storeId),
            'capacity' => $this->aiConfig->getCapacityConfig($storeId),
            'attachments' => $this->aiConfig->getAttachmentConfig($storeId),
            'voice' => $this->aiConfig->getVoiceConfig($storeId),
            'magento_oauth' => $this->aiConfig->getMagentoOauthConfig($storeId),
        ];
    }

    private function decodeResponse(string $responseBody): array
    {
        if ($responseBody === '') {
            return [];
        }

        try {
            $response = $this->json->unserialize($responseBody);
            return is_array($response) ? $response : [];
        } catch (\InvalidArgumentException $exception) {
            return [];
        }
    }

    private function saveStatus(
        string $state,
        string $message,
        ?string $syncId = null,
        ?int $httpStatus = null,
        string $provider = '',
        string $model = ''
    ): void {
        $status = [
            'state' => $state,
            'message' => substr($message, 0, 255),
            'synced_at' => gmdate('c'),
            'sync_id' => $syncId,
            'http_status' => $httpStatus,
            'provider' => $provider,
            'model' => $model,
        ];

        try {
            $this->configWriter->save(
                AiConfig::XML_PATH_NODE_SYNC_STATUS,
                $this->json->serialize($status),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );
        } catch (\Throwable $error) {
            $this->logger->warning('Could not save Afd AI Node sync status: ' . $error->getMessage());
        }
    }

    private function toHttpUrl(string $url): string
    {
        if (str_starts_with($url, 'wss://')) {
            return 'https://' . substr($url, 6);
        }

        if (str_starts_with($url, 'ws://')) {
            return 'http://' . substr($url, 5);
        }

        if (str_starts_with($url, 'http://') || str_starts_with($url, 'https://')) {
            return $url;
        }

        return '';
    }
}
