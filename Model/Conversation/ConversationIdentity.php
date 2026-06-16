<?php
declare(strict_types=1);

namespace Afd\AI\Model\Conversation;

use Magento\Framework\App\ResourceConnection;

/** Central ownership checks for browser and gateway conversation actions. */
class ConversationIdentity
{
    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    public function ownsConversation(int $conversationId, ?int $customerId, ?string $guestId): bool
    {
        if ($conversationId < 1) {
            return false;
        }

        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from($this->resource->getTableName('afd_ai_conversation'), ['conversation_id'])
            ->where('conversation_id = ?', $conversationId)
            ->limit(1);
        $this->applyOwnerFilter($select, $customerId, $guestId);

        return $connection->fetchOne($select) !== false;
    }

    public function ownsAssistantMessage(
        int $conversationId,
        int $messageId,
        ?int $customerId,
        ?string $guestId
    ): bool {
        if ($messageId < 1 || !$this->ownsConversation($conversationId, $customerId, $guestId)) {
            return false;
        }

        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from($this->resource->getTableName('afd_ai_message'), ['entity_id'])
            ->where('entity_id = ?', $messageId)
            ->where('conversation_id = ?', $conversationId)
            ->where('role IN (?)', ['assistant', 'model'])
            ->limit(1);

        return $connection->fetchOne($select) !== false;
    }

    private function applyOwnerFilter(object $select, ?int $customerId, ?string $guestId): void
    {
        if (($customerId ?? 0) > 0) {
            $select->where('customer_id = ?', (int)$customerId);
            return;
        }

        $normalizedGuestId = strtolower(trim((string)$guestId));
        if (!preg_match('/^[a-f0-9]{64}$/', $normalizedGuestId)) {
            $select->where('1 = 0');
            return;
        }
        $select->where('guest_id = ?', $normalizedGuestId);
    }
}
