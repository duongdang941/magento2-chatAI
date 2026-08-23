<?php
declare(strict_types=1);

namespace Afd\AI\Model\Api;

use Afd\AI\Api\ConfigInterface;
use Afd\AI\Api\Data\AiConfigInterfaceFactory;
use Afd\AI\Model\Config\Config as AiConfigProvider;

class Config implements ConfigInterface
{
    public function __construct(
        private readonly AiConfigInterfaceFactory $aiConfigFactory,
        private readonly AiConfigProvider $aiConfigProvider
    ) {
    }

    /**
     * @inheritDoc
     */
    public function getActiveConfig()
    {
        $config = $this->aiConfigFactory->create();
        $config->setProvider($this->aiConfigProvider->getProvider());
        $config->setModel($this->aiConfigProvider->getModel());
        $config->setApiKey($this->aiConfigProvider->getApiKey());
        $config->setBaseUrl($this->aiConfigProvider->getBaseUrl());

        return $config;
    }
}
