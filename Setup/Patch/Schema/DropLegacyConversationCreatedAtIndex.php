<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Schema;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Setup\Patch\SchemaPatchInterface;

/**
 * Replaces the legacy cursor-incompatible conversation/created_at index.
 */
class DropLegacyConversationCreatedAtIndex implements SchemaPatchInterface
{
    private const LEGACY_INDEX = 'AFD_AI_MESSAGE_CONVERSATION_ID_CREATED_AT';

    private ResourceConnection $resourceConnection;

    public function __construct(ResourceConnection $resourceConnection)
    {
        $this->resourceConnection = $resourceConnection;
    }

    public function apply(): void
    {
        $connection = $this->resourceConnection->getConnection();
        $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
        $indexes = $connection->getIndexList($messageTable);

        if (isset($indexes[self::LEGACY_INDEX])) {
            $connection->dropIndex($messageTable, self::LEGACY_INDEX);
        }
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
