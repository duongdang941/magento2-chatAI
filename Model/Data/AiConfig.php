<?php
declare(strict_types=1);

namespace Afd\AI\Model\Data;

use Afd\AI\Api\Data\AiConfigInterface;
use Magento\Framework\DataObject;

class AiConfig extends DataObject implements AiConfigInterface
{
    public function getProvider()
    {
        return $this->getData(self::PROVIDER);
    }

    public function setProvider($provider)
    {
        return $this->setData(self::PROVIDER, $provider);
    }

    public function getModel()
    {
        return $this->getData(self::MODEL);
    }

    public function setModel($model)
    {
        return $this->setData(self::MODEL, $model);
    }

    public function getApiKey()
    {
        return $this->getData(self::API_KEY);
    }

    public function setApiKey($apiKey)
    {
        return $this->setData(self::API_KEY, $apiKey);
    }

    public function getBaseUrl()
    {
        return $this->getData(self::BASE_URL);
    }

    public function setBaseUrl($baseUrl)
    {
        return $this->setData(self::BASE_URL, $baseUrl);
    }
}
