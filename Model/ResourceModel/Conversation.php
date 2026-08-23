<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel;

use Magento\Framework\Model\ResourceModel\Db\AbstractDb;

class Conversation extends AbstractDb
{
    protected function _construct()
    {
        $this->_init('afd_ai_conversation', 'conversation_id');
    }

    /**
     * Delete a conversation and its messages in a single transaction.
     */
    public function deleteRows(int $conversationId): void
    {
        if ($conversationId < 1) {
            return;
        }

        $connection = $this->getConnection();
        $connection->beginTransaction();
        try {
            $connection->delete(
                $this->getTable('afd_ai_message'),
                ['conversation_id = ?' => $conversationId]
            );
            $connection->delete(
                $this->getMainTable(),
                ['conversation_id = ?' => $conversationId]
            );
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }

    /**
     * Truncate a conversation branch starting at a user message.
     *
     * @return bool False when the anchor is not a user message.
     */
    public function truncateMessagesFrom(int $conversationId, int $fromMessageId): bool
    {
        if ($conversationId < 1 || $fromMessageId < 1) {
            return false;
        }

        $connection = $this->getConnection();
        $messageTable = $this->getTable('afd_ai_message');
        $role = $connection->fetchOne(
            $connection->select()
                ->from($messageTable, ['role'])
                ->where('conversation_id = ?', $conversationId)
                ->where('entity_id = ?', $fromMessageId)
        );
        if ($role !== 'user') {
            return false;
        }

        $connection->beginTransaction();
        try {
            $connection->delete($messageTable, [
                'conversation_id = ?' => $conversationId,
                'entity_id >= ?' => $fromMessageId,
            ]);
            $connection->commit();
            return true;
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }

    /**
     * @return int[]
     */
    public function getAiConversationIdsForGuest(string $guestId, int $storeId, int $websiteId): array
    {
        $connection = $this->getConnection();
        $ids = $connection->fetchCol(
            $connection->select()
                ->from($this->getMainTable(), ['conversation_id'])
                ->where('guest_id = ?', $guestId)
                ->where('store_id = ?', $storeId)
                ->where('website_id = ?', $websiteId)
                ->where('conversation_type = ?', 'ai')
        );

        return array_values(array_map('intval', $ids));
    }

    /**
     * @param int[] $conversationIds
     */
    public function deleteRowsByIds(array $conversationIds): void
    {
        $conversationIds = array_values(array_unique(array_filter(array_map('intval', $conversationIds))));
        if ($conversationIds === []) {
            return;
        }

        $connection = $this->getConnection();
        $connection->beginTransaction();
        try {
            $connection->delete(
                $this->getTable('afd_ai_message'),
                ['conversation_id IN (?)' => $conversationIds]
            );
            $connection->delete(
                $this->getMainTable(),
                ['conversation_id IN (?)' => $conversationIds]
            );
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }
}