<?php
declare(strict_types=1);

namespace Afd\AI\Model\Privacy;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Store\Model\ScopeInterface;

class RetentionCleaner
{
    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly ConversationDataEraser $conversationDataEraser,
        private readonly ResourceConnection $resource
    ) {
    }

    /** @return array{conversations:int,messages:int,resolved_cases:int} */
    public function execute(?int $now = null): array
    {
        $now ??= time();
        $connection = $this->resource->getConnection();
        $deleted = ['conversations' => 0, 'messages' => 0];
        $deletedCases = 0;
        // Enumerating live store views would let rows of deleted store views
        // age out never, so drive cleanup by the scopes actually present.
        foreach ($this->existingStoreScopes() as $scope) {
            $storeId = $scope['store_id'];
            $websiteId = $scope['website_id'];
            $conversationDays = $this->retentionDays('afd_ai/privacy/conversation_retention_days', 90, 730, $storeId);
            $caseDays = $this->retentionDays('afd_ai/privacy/resolved_case_retention_days', 365, 2555, $storeId);
            $expired = $this->conversationDataEraser->eraseExpired(
                gmdate('Y-m-d H:i:s', $now - ($conversationDays * 86400)),
                $storeId,
                $websiteId
            );
            $deleted['conversations'] += $expired['conversations'];
            $deleted['messages'] += $expired['messages'];
            $deletedCases += $connection->delete(
                $this->resource->getTableName('afd_ai_support_case'),
                [
                    'store_id = ?' => $storeId,
                    'website_id = ?' => $websiteId,
                    'status IN (?)' => ['resolved', 'closed'],
                    'resolved_at < ?' => gmdate('Y-m-d H:i:s', $now - ($caseDays * 86400)),
                ]
            );
        }
        return [
            'conversations' => $deleted['conversations'],
            'messages' => $deleted['messages'],
            'resolved_cases' => $deletedCases,
        ];
    }

    /** @return array<int, array{store_id:int,website_id:int}> */
    private function existingStoreScopes(): array
    {
        $connection = $this->resource->getConnection();
        $scopes = [];
        foreach (['afd_ai_conversation', 'afd_ai_support_case'] as $table) {
            $tableName = $this->resource->getTableName($table);
            if (!$connection->isTableExists($tableName)) {
                continue;
            }
            foreach ($connection->fetchAll(
                $connection->select()
                    ->from($tableName, ['store_id', 'website_id'])
                    ->distinct(true)
            ) as $row) {
                $key = (int)$row['store_id'] . ':' . (int)$row['website_id'];
                $scopes[$key] = [
                    'store_id' => (int)$row['store_id'],
                    'website_id' => (int)$row['website_id'],
                ];
            }
        }

        return array_values($scopes);
    }

    private function retentionDays(string $path, int $fallback, int $maximum, int $storeId): int
    {
        $value = (int)$this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId);
        return max(1, min($value > 0 ? $value : $fallback, $maximum));
    }
}
