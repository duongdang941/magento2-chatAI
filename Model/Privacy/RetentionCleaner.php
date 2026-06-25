<?php
declare(strict_types=1);

namespace Afd\AI\Model\Privacy;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

class RetentionCleaner
{
    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly ConversationDataEraser $conversationDataEraser,
        private readonly ResourceConnection $resource,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /** @return array{conversations:int,messages:int,resolved_cases:int} */
    public function execute(?int $now = null): array
    {
        $now ??= time();
        $connection = $this->resource->getConnection();
        $deleted = ['conversations' => 0, 'messages' => 0];
        $deletedCases = 0;
        foreach ($this->storeManager->getStores(true) as $store) {
            if (!(bool)$store->isActive()) {
                continue;
            }

            $storeId = (int)$store->getId();
            $websiteId = (int)$store->getWebsiteId();
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

    private function retentionDays(string $path, int $fallback, int $maximum, int $storeId): int
    {
        $value = (int)$this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId);
        return max(1, min($value > 0 ? $value : $fallback, $maximum));
    }
}
