<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Data;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Setup\Patch\DataPatchInterface;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\StoreManagerInterface;
use Psr\Log\LoggerInterface;

/** Assign legacy conversations to Magento's default store before scope filters activate. */
class BackfillConversationStoreScope implements DataPatchInterface
{
    public function __construct(
        private readonly ResourceConnection $resourceConnection,
        private readonly StoreManagerInterface $storeManager,
        private readonly LoggerInterface $logger
    ) {
    }

    public function apply(): void
    {
        $connection = $this->resourceConnection->getConnection();
        $table = $this->resourceConnection->getTableName('afd_ai_conversation');
        if (!$connection->isTableExists($table)) {
            return;
        }

        $store = $this->resolveDefaultStore();
        if ($store === null) {
            // Without any store view, scope 0 keeps its "all stores" meaning.
            // The patch stays idempotent and a later run can backfill again.
            $this->logger->warning(
                'Afd AI conversation scope backfill skipped: no store view exists yet.'
            );
            return;
        }

        $connection->update($table, [
            'store_id' => (int)$store->getId(),
            'website_id' => (int)$store->getWebsiteId(),
        ], 'store_id = 0 OR website_id = 0');
    }

    private function resolveDefaultStore(): ?StoreInterface
    {
        // getDefaultStoreView() is documented to return null when no store is
        // marked default; fall back to the first available store view so the
        // patch cannot fatally wedge setup:upgrade mid-run.
        $default = $this->storeManager->getDefaultStoreView();
        if ($default !== null) {
            return $default;
        }

        foreach ($this->storeManager->getStores(true) as $store) {
            return $store;
        }

        return null;
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
