<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Data;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Setup\Patch\DataPatchInterface;

/**
 * Creates the two gateway trust secrets once for each installation.
 *
 * Existing values are deliberately preserved: rotating one secret requires a
 * coordinated restart of every gateway replica, and must always be explicit.
 */
class EnsureGatewaySecrets implements DataPatchInterface
{
    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly WriterInterface $configWriter
    ) {
    }

    public function apply(): self
    {
        foreach ([AiConfig::XML_PATH_NODE_SYNC_SECRET, AiConfig::XML_PATH_WS_TICKET_SECRET] as $path) {
            $existingValue = (string)$this->scopeConfig->getValue(
                $path,
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );
            if (strlen(trim($existingValue)) >= 32) {
                continue;
            }

            $this->configWriter->save(
                $path,
                bin2hex(random_bytes(32)),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );
        }

        return $this;
    }

    public static function getDependencies(): array
    {
        return [];
    }

    public function getAliases(): array
    {
        return [];
    }
}
