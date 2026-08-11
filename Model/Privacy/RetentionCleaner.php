<?php
declare(strict_types=1);

namespace Afd\AI\Model\Privacy;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;

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
        $conversationDays = max(1, min((int)$this->scopeConfig->getValue('afd_ai/privacy/conversation_retention_days'), 730));
        $caseDays = max(1, min((int)$this->scopeConfig->getValue('afd_ai/privacy/resolved_case_retention_days'), 2555));
        $deleted = $this->conversationDataEraser->eraseExpired(
            gmdate('Y-m-d H:i:s', $now - ($conversationDays * 86400))
        );
        $connection = $this->resource->getConnection();
        $deletedCases = $connection->delete(
            $this->resource->getTableName('afd_ai_support_case'),
            [
                'status IN (?)' => ['resolved', 'closed'],
                'resolved_at < ?' => gmdate('Y-m-d H:i:s', $now - ($caseDays * 86400)),
            ]
        );
        return [
            'conversations' => $deleted['conversations'],
            'messages' => $deleted['messages'],
            'resolved_cases' => $deletedCases,
        ];
    }

}
