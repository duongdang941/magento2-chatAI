<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\Analytics;

use Magento\Backend\Block\Template;
use Magento\Backend\Block\Template\Context;
use Magento\Framework\App\ResourceConnection;

class Dashboard extends Template
{
    public function __construct(Context $context, private readonly ResourceConnection $resource, array $data = [])
    {
        parent::__construct($context, $data);
    }

    public function getFunnel(): array
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName('afd_ai_analytics_event');
        $since = gmdate('Y-m-d H:i:s', time() - 30 * 86400);
        $count = fn (string $name): int => (int)$connection->fetchOne(
            $connection->select()->from($table, ['COUNT(*)'])->where('event_name = ?', $name)->where('occurred_at >= ?', $since)
        );
        return [
            'answers' => $count('answer_completed'),
            'recommendations' => $count('recommendation_shown'),
            'cart_adds' => $count('add_to_cart'),
            'checkouts' => $count('checkout_started'),
            'orders' => $count('order_placed'),
        ];
    }

    public function getRecentEvents(): array
    {
        return $this->resource->getConnection()->fetchAll(
            $this->resource->getConnection()->select()
                ->from($this->resource->getTableName('afd_ai_analytics_event'), ['event_name', 'conversation_id', 'candidate_set_id', 'provider', 'model', 'payload_json', 'occurred_at'])
                ->order('occurred_at DESC')->limit(50)
        );
    }
}
