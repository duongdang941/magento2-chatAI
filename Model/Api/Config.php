<?php
declare(strict_types=1);

namespace Afd\AI\Model\Api;

use Afd\AI\Api\ConfigInterface;
use Afd\AI\Api\Data\AiConfigInterfaceFactory;
use Afd\AI\Model\Config\Config as AiConfigProvider;

class Config implements ConfigInterface
{
    private $aiConfigFactory;
    private $aiConfigProvider;

    public function __construct(
        AiConfigInterfaceFactory $aiConfigFactory,
        AiConfigProvider $aiConfigProvider
    ) {
        $this->aiConfigFactory = $aiConfigFactory;
        $this->aiConfigProvider = $aiConfigProvider;
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
