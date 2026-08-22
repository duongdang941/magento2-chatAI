<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Api\Data\ProviderInterface;
use Afd\AI\Model\ProviderFactory;
use Afd\AI\Model\ResourceModel\Provider as ResourceModel;
use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Afd\AI\Model\Provider\ProviderConfigurationValidator;
use Magento\Framework\Exception\NoSuchEntityException;
use Magento\Framework\Exception\CouldNotSaveException;
use Magento\Framework\Exception\CouldNotDeleteException;
use Magento\Framework\Exception\LocalizedException;

class ProviderRepository implements ProviderRepositoryInterface
{
    public function __construct(
        private readonly ProviderFactory $providerFactory,
        private readonly ResourceModel $resource,
        private readonly CollectionFactory $collectionFactory,
        private readonly ProviderApiKeyNormalizer $apiKeyNormalizer,
        private readonly ProviderConfigurationValidator $configurationValidator
    ) {}

    public function save(ProviderInterface $provider): ProviderInterface
    {
        try {
            $this->configurationValidator->validate($provider);
            $apiKey = $provider->getApiKey();
            if ($apiKey !== null && $apiKey !== "") {
                $provider->setApiKey($this->apiKeyNormalizer->forStorage($apiKey));
            }
            $this->resource->save($provider);
        } catch (LocalizedException $e) {
            throw $e;
        } catch (\Exception $e) {
            throw new CouldNotSaveException(__("Could not save AI provider: %1", $e->getMessage()), $e);
        }
        return $provider;
    }

    public function getById(int $providerId): ProviderInterface
    {
        $provider = $this->providerFactory->create();
        $this->resource->load($provider, $providerId);
        if (!$provider->getId()) {
            throw new NoSuchEntityException(__("AI provider with ID %1 does not exist.", $providerId));
        }
        return $provider;
    }

    public function getByCode(string $providerCode): ProviderInterface
    {
        $provider = $this->providerFactory->create();
        $this->resource->load($provider, $providerCode, "provider_code");
        if (!$provider->getId()) {
            throw new NoSuchEntityException(__("AI provider with code %1 does not exist.", $providerCode));
        }
        return $provider;
    }

    public function delete(ProviderInterface $provider): bool
    {
        try {
            $this->resource->delete($provider);
        } catch (\Exception $e) {
            throw new CouldNotDeleteException(__("Could not delete AI provider: %1", $e->getMessage()), $e);
        }
        return true;
    }

    public function deleteById(int $providerId): bool
    {
        return $this->delete($this->getById($providerId));
    }

    public function getList(bool $onlyActive = false): array
    {
        $collection = $this->collectionFactory->create();
        if ($onlyActive) {
            $collection->addFieldToFilter(ProviderInterface::IS_ACTIVE, 1);
        }
        $collection->setOrder(ProviderInterface::NAME, "ASC");
        return $collection->getItems();
    }
}
