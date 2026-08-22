<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\Data\ProviderInterface;
use Magento\Framework\Model\AbstractModel;
use Afd\AI\Model\ResourceModel\Provider as ResourceModel;

class Provider extends AbstractModel implements ProviderInterface
{
    protected function _construct(): void
    {
        $this->_init(ResourceModel::class);
    }

    public function getProviderId(): ?int
    {
        $val = $this->getData(self::PROVIDER_ID);
        return $val !== null ? (int)$val : null;
    }

    public function setProviderId(int $providerId): self
    {
        return $this->setData(self::PROVIDER_ID, $providerId);
    }

    public function getName(): ?string
    {
        return $this->getData(self::NAME);
    }

    public function setName(string $name): self
    {
        return $this->setData(self::NAME, $name);
    }

    public function getProviderCode(): ?string
    {
        return $this->getData(self::PROVIDER_CODE);
    }

    public function setProviderCode(string $providerCode): self
    {
        return $this->setData(self::PROVIDER_CODE, $providerCode);
    }

    public function getBaseUrl(): ?string
    {
        return $this->getData(self::BASE_URL);
    }

    public function setBaseUrl(string $baseUrl): self
    {
        return $this->setData(self::BASE_URL, $baseUrl);
    }

    public function getApiKey(): ?string
    {
        return $this->getData(self::API_KEY);
    }

    public function setApiKey(?string $apiKey): self
    {
        return $this->setData(self::API_KEY, $apiKey);
    }

    public function getApiFormat(): ?string
    {
        return $this->getData(self::API_FORMAT) ?: self::FORMAT_ANTHROPIC_MESSAGES;
    }

    public function setApiFormat(string $apiFormat): self
    {
        return $this->setData(self::API_FORMAT, $apiFormat);
    }

    public function getModelsJson(): ?string
    {
        return $this->getData(self::MODELS_JSON);
    }

    public function setModelsJson(?string $modelsJson): self
    {
        return $this->setData(self::MODELS_JSON, $modelsJson);
    }

    public function getModelsList(): array
    {
        $raw = $this->getModelsJson();
        if (!$raw) {
            return [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }

    public function setModelsList(array $models): self
    {
        return $this->setModelsJson(json_encode(array_values($models), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    public function getIsActive(): bool
    {
        return (bool)$this->getData(self::IS_ACTIVE);
    }

    public function setIsActive(bool $isActive): self
    {
        return $this->setData(self::IS_ACTIVE, $isActive ? 1 : 0);
    }

    public function getCreatedAt(): ?string
    {
        return $this->getData(self::CREATED_AT);
    }

    public function getUpdatedAt(): ?string
    {
        return $this->getData(self::UPDATED_AT);
    }
}
