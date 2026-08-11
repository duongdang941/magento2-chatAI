<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Data;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Setup\Patch\DataPatchInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Assign legacy conversations to Magento's default store before scope filters activate. */
class BackfillConversationStoreScope implements DataPatchInterface
{
    public function __construct(
        private readonly ResourceConnection $resourceConnection,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    public function apply(): void
    {
        $connection = $this->resourceConnection->getConnection();
        $table = $this->resourceConnection->getTableName('afd_ai_conversation');
        if (!$connection->isTableExists($table)) {
            return;
        }

        $store = $this->storeManager->getDefaultStoreView();
        $connection->update($table, [
            'store_id' => (int)$store->getId(),
            'website_id' => (int)$store->getWebsiteId(),
        ], 'store_id = 0 OR website_id = 0');
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
