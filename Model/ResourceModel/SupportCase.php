<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel;

use Magento\Framework\Model\ResourceModel\Db\AbstractDb;

class SupportCase extends AbstractDb
{
    protected function _construct(): void
    {
        $this->_init('afd_ai_support_case', 'entity_id');
    }

    public function closeByConversationId(int $conversationId, string $now): void
    {
        if ($conversationId < 1) {
            return;
        }

        $this->getConnection()->update(
            $this->getMainTable(),
            [
                'status' => 'closed',
                'takeover_state' => 'inactive',
                'takeover_expires_at' => null,
                'takeover_ended_at' => $now,
                'resolved_at' => $now,
                'updated_at' => $now,
            ],
            ['conversation_id = ?' => $conversationId]
        );
    }
}