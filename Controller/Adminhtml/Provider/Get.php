<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;
use Afd\AI\Model\ProviderApiKeyNormalizer;

class Get extends Action implements HttpGetActionInterface
{
    public const ADMIN_RESOURCE = "Afd_AI::providers";

    public function __construct(
        Context $context,
        private readonly ProviderRepositoryInterface $providerRepository,
        private readonly JsonFactory $jsonFactory,
        private readonly ProviderApiKeyNormalizer $apiKeyNormalizer
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        $result = $this->jsonFactory->create();
        $providerId = (int)$this->getRequest()->getParam("provider_id");

        try {
            $provider = $this->providerRepository->getById($providerId);
            $apiKey = $provider->getApiKey();
            $decryptedKey = $this->apiKeyNormalizer->forDisplay($apiKey);

            return $result->setData([
                "success" => true,
                "provider" => [
                    "provider_id" => $provider->getProviderId(),
                    "name" => $provider->getName(),
                    "provider_code" => $provider->getProviderCode(),
                    "base_url" => $provider->getBaseUrl(),
                    // Provider management is an explicitly authorized Admin
                    // surface. Return the stored key here so an administrator
                    // can review and edit it in the provider modal.
                    "api_key" => $decryptedKey,
                    "api_key_configured" => $decryptedKey !== '',
                    "api_format" => $provider->getApiFormat(),
                    "models" => $this->jsonSafeValue($provider->getModelsList()),
                    "is_active" => $provider->getIsActive() ? 1 : 0
                ]
            ]);
        } catch (\Throwable $e) {
            return $result->setData([
                "success" => false,
                "message" => $e->getMessage()
            ]);
        }
    }

    private function jsonSafeValue(mixed $value): mixed
    {
        if (is_string($value)) {
            return mb_check_encoding($value, 'UTF-8') ? $value : '';
        }
        if (is_array($value)) {
            $safe = [];
            foreach ($value as $key => $item) {
                $safe[is_string($key) && mb_check_encoding($key, 'UTF-8') ? $key : (string)$key] = $this->jsonSafeValue($item);
            }
            return $safe;
        }
        return $value;
    }
}
