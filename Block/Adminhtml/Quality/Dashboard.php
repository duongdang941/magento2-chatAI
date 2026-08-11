<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\Quality;

use Magento\Backend\Block\Template;
use Magento\Backend\Block\Template\Context;
use Magento\Framework\App\ResourceConnection;

class Dashboard extends Template
{
    public function __construct(
        Context $context,
        private readonly ResourceConnection $resource,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    /** @return array<string, int|float> */
    public function getMetrics(): array
    {
        $connection = $this->resource->getConnection();
        $feedback = $this->resource->getTableName('afd_ai_feedback');
        $cases = $this->resource->getTableName('afd_ai_support_case');
        $since = gmdate('Y-m-d H:i:s', time() - (30 * 86400));
        $total = (int)$connection->fetchOne($connection->select()->from($feedback, ['COUNT(*)'])->where('created_at >= ?', $since));
        $positive = (int)$connection->fetchOne($connection->select()->from($feedback, ['COUNT(*)'])->where('created_at >= ?', $since)->where('rating = ?', 'positive'));
        $negative = max(0, $total - $positive);
        $openCases = (int)$connection->fetchOne($connection->select()->from($cases, ['COUNT(*)'])->where('status IN (?)', ['open', 'in_progress', 'waiting_customer']));
        return [
            'feedback_total' => $total,
            'positive' => $positive,
            'negative' => $negative,
            'helpful_rate' => $total > 0 ? round(($positive / $total) * 100, 1) : 0.0,
            'open_cases' => $openCases,
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function getRecentNegativeFeedback(): array
    {
        $connection = $this->resource->getConnection();
        return $connection->fetchAll(
            $connection->select()
                ->from($this->resource->getTableName('afd_ai_feedback'), ['conversation_id', 'message_id', 'reason', 'comment', 'created_at'])
                ->where('rating = ?', 'negative')
                ->order('feedback_id DESC')
                ->limit(20)
        );
    }
}
