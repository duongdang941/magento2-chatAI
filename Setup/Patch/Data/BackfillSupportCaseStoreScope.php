<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Data;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Setup\Patch\DataPatchInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Gives legacy support cases the same immutable storefront boundary as their thread. */
class BackfillSupportCaseStoreScope implements DataPatchInterface
{
    public function __construct(
        private readonly ResourceConnection $resourceConnection,
        private readonly StoreManagerInterface $storeManager
    ) {}

    public function apply(): void
    {
        $connection = $this->resourceConnection->getConnection();
        $caseTable = $this->resourceConnection->getTableName('afd_ai_support_case');
        $conversationTable = $this->resourceConnection->getTableName('afd_ai_conversation');
        if (!$connection->isTableExists($caseTable) || !$connection->isTableExists($conversationTable)) {
            return;
        }

        $connection->query(sprintf(
            'UPDATE %s AS support_case INNER JOIN %s AS conversation '
            . 'ON conversation.conversation_id = support_case.conversation_id '
            . 'SET support_case.store_id = conversation.store_id, support_case.website_id = conversation.website_id '
            . 'WHERE support_case.store_id = 0 OR support_case.website_id = 0',
            $connection->quoteIdentifier($caseTable),
            $connection->quoteIdentifier($conversationTable)
        ));

        // Privacy-redacted legacy cases may no longer have a linked thread.
        // They belonged to the default storefront before scope existed, so
        // retain and clean them under that same default policy.
        $defaultStore = $this->storeManager->getDefaultStoreView();
        $connection->update($caseTable, [
            'store_id' => (int)$defaultStore->getId(),
            'website_id' => (int)$defaultStore->getWebsiteId(),
        ], 'store_id = 0 OR website_id = 0');
    }

    public static function getDependencies(): array
    {
        return [BackfillConversationStoreScope::class];
    }

    public function getAliases(): array
    {
        return [];
    }
}
