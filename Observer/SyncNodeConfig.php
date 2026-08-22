<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Gateway\GatewayTlsConfigurator;
use Afd\AI\Model\Gateway\InternalRequestSigner;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\Exception\LocalizedException;
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
    private ProviderRepositoryInterface $providerRepository;

    public function __construct(
        Curl $curl,
        AiConfig $aiConfig,
        WriterInterface $configWriter,
        Json $json,
        LoggerInterface $logger,
        StoreManagerInterface $storeManager,
        InternalRequestSigner $requestSigner,
        GatewayTlsConfigurator $gatewayTlsConfigurator,
        ProviderRepositoryInterface $providerRepository
    ) {
        $this->curl = $curl;
        $this->aiConfig = $aiConfig;
        $this->configWriter = $configWriter;
        $this->json = $json;
        $this->logger = $logger;
        $this->storeManager = $storeManager;
        $this->requestSigner = $requestSigner;
        $this->gatewayTlsConfigurator = $gatewayTlsConfigurator;
        $this->providerRepository = $providerRepository;
    }

    public function execute(Observer $observer): void
    {
        $this->sync();
    }

    /**
     * Push the current Magento configuration to Node.
     *
     * When a provider ID is supplied, it is deliberately checked against the
     * provider selected in Magento before any credentials leave this server.
     * The same method is used by the automatic config observer and the Admin
     * "Sync to Node" action.
     *
     * @return array{success:bool,message:string,sync_id?:string,http_status?:int,provider?:string,model?:string}
     */
    public function sync(?int $providerId = null): array
    {
        try {
            $syncProvider = $this->resolveSyncProvider($providerId);
            return $this->pushConfiguration($syncProvider);
        } catch (LocalizedException $error) {
            $message = $error->getMessage();
            $this->saveStatus('failed', $message);
            return ['success' => false, 'message' => $message, 'http_status' => 422];
        } catch (\Throwable $error) {
            $this->saveStatus('failed', 'Could not prepare the Node configuration sync.');
            $this->logger->warning('Afd AI config push could not be prepared: ' . $error->getMessage());
            return [
                'success' => false,
                'message' => 'Could not prepare the Node configuration sync.',
                'http_status' => 500,
            ];
        }
    }

    private function resolveSyncProvider(?int $providerId): ?ProviderInterface
    {
        $current = $this->aiConfig->getActiveProviderEntity();
        $currentCode = trim((string)$this->aiConfig->getProvider());
        if ($current && $currentCode === '') {
            $currentCode = trim((string)$current->getProviderCode());
        }

        if ($providerId === null) {
            if ($currentCode === '') {
                throw new LocalizedException(__('Select an active AI provider before syncing to Node.'));
            }
            return $current;
        }

        $requested = $this->providerRepository->getById($providerId);
        $requestedCode = trim((string)$requested->getProviderCode());
        if (!$requested->getIsActive()) {
            throw new LocalizedException(__('Only an active provider can be synchronized to Node.'));
        }
        if ($currentCode === '' || !hash_equals($currentCode, $requestedCode)) {
            throw new LocalizedException(
                __('The provider being synchronized must match the provider currently selected in AI Configuration.')
            );
        }

        return $requested;
    }

    /** @return array{success:bool,message:string,sync_id?:string,http_status?:int,provider?:string,model?:string} */
    private function pushConfiguration(?ProviderInterface $syncProvider): array
    {
        $serverUrl = trim((string)$this->aiConfig->getChatServerUrl());
        if ($serverUrl === '') {
            $this->saveStatus('failed', 'Node server URL is not configured.');
            return ['success' => false, 'message' => 'Node server URL is not configured.', 'http_status' => 422];
        }

        $reloadUrl = $this->toHttpUrl($serverUrl);
        if ($reloadUrl === '') {
            $this->saveStatus('failed', 'Node server URL is invalid.');
            return ['success' => false, 'message' => 'Node server URL is invalid.', 'http_status' => 422];
        }

        $secret = $this->aiConfig->getNodeSyncSecret();
        if (strlen($secret) < 32) {
            $this->saveStatus('failed', 'Node sync secret is not configured.');
            $this->logger->warning('Afd AI configuration was not pushed because the Node sync secret is too short.');
            return ['success' => false, 'message' => 'Node sync secret is not configured.', 'http_status' => 422];
        }

        $syncId = bin2hex(random_bytes(16));
        $reloadUrl = rtrim($reloadUrl, '/') . '/internal/config';
        $configSnapshot = $this->buildConfigSnapshot();
        $tenantId = $this->aiConfig->getTenantId();
        if ($tenantId === '') {
            $this->saveStatus('failed', 'Magento base URL is not configured for this installation.');
            return [
                'success' => false,
                'message' => 'Magento base URL is not configured for this installation.',
                'sync_id' => $syncId,
                'http_status' => 422,
            ];
        }
        $configSnapshot['tenant_id'] = $tenantId;
        $syncProviderCode = $syncProvider
            ? trim((string)$syncProvider->getProviderCode())
            : trim((string)$this->aiConfig->getProvider());
        // An empty Magento provider setting historically meant "first active
        // provider". Materialize that resolved value in the snapshot so Node
        // can validate the provider identity without changing that fallback.
        if (trim((string)($configSnapshot['default']['provider'] ?? '')) === '' && $syncProviderCode !== '') {
            $configSnapshot['default']['provider'] = $syncProviderCode;
        }
        $payload = [
            'version' => 3,
            'sync_id' => $syncId,
            'sync_provider' => [
                'provider_id' => $syncProvider?->getProviderId(),
                'provider_code' => $syncProviderCode,
            ],
            'config' => $configSnapshot,
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
                return [
                    'success' => false,
                    'message' => $message !== '' ? $message : sprintf('Node returned HTTP %d.', $status),
                    'sync_id' => $syncId,
                    'http_status' => $status,
                ];
            }

            if (($response['sync_id'] ?? null) !== $syncId) {
                $this->saveStatus('failed', 'Node returned an invalid synchronization response.', $syncId, $status);
                $this->logger->warning('Afd AI config push returned a response with an unexpected sync ID.');
                return [
                    'success' => false,
                    'message' => 'Node returned an invalid synchronization response.',
                    'sync_id' => $syncId,
                    'http_status' => $status,
                ];
            }

            $message = (string)($response['message'] ?? 'Node accepted the configuration.');
            $provider = (string)($response['provider'] ?? $payload['config']['default']['provider']);
            $model = (string)($response['model'] ?? $payload['config']['default']['model']);
            $this->saveStatus(
                'success',
                $message,
                $syncId,
                $status,
                $provider,
                $model
            );
            return [
                'success' => true,
                'message' => $message,
                'sync_id' => $syncId,
                'http_status' => $status,
                'provider' => $provider,
                'model' => $model,
            ];
        } catch (\Throwable $error) {
            $this->saveStatus('failed', 'Could not reach the Node service.', $syncId);
            $this->logger->warning(sprintf(
                'Afd AI config push failed for %s: %s',
                $reloadUrl,
                $error->getMessage()
            ));
            return [
                'success' => false,
                'message' => 'Could not reach the Node service.',
                'sync_id' => $syncId,
                'http_status' => 502,
            ];
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
        $providerCode = trim((string)$this->aiConfig->getProvider($storeId));
        if ($providerCode === '') {
            $providerCode = trim((string)($this->aiConfig->getActiveProviderEntity($storeId)?->getProviderCode() ?? ''));
        }

        return [
            'enabled' => $this->aiConfig->isEnabled($storeId),
            'persist_guest_history' => $this->aiConfig->isGuestHistoryPersistenceEnabled($storeId),
            'provider' => $providerCode,
            'model' => (string)$this->aiConfig->getModel($storeId),
            'thought_level' => $this->aiConfig->getThoughtLevel($storeId),
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
            'api_format' => $this->aiConfig->getApiFormat($storeId),
            'providers' => $this->aiConfig->getAllActiveProvidersConfig(),
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
