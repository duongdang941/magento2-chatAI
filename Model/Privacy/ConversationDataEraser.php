<?php
declare(strict_types=1);

namespace Afd\AI\Model\Privacy;

use Afd\AI\Model\ChatAttachmentStorage;
use Magento\Framework\App\ResourceConnection;

/**
 * Owns destructive chat persistence operations.
 *
 * Message rows must be removed explicitly before their conversation because
 * the declarative FK intentionally uses SET NULL for non-destructive legacy
 * migrations. Keeping deletion here prevents privacy and retention flows from
 * silently leaving orphan messages or attachment directories behind.
 */
class ConversationDataEraser
{
    private const RETENTION_BATCH_SIZE = 500;

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ChatAttachmentStorage $attachmentStorage
    ) {
    }

    /** @return array{conversations:int,messages:int} */
    public function eraseOwned(?int $customerId, ?string $guestId): array
    {
        $owner = $this->ownerCondition($customerId, $guestId);
        if ($owner === null) {
            return ['conversations' => 0, 'messages' => 0];
        }

        $rows = $this->fetchConversationRows([$owner['sql'] => $owner['value']]);
        if ($rows === []) {
            return ['conversations' => 0, 'messages' => 0];
        }

        $connection = $this->resource->getConnection();
        $connection->beginTransaction();
        try {
            $connection->update(
                $this->resource->getTableName('afd_ai_support_case'),
                [
                    'conversation_id' => null,
                    'source_conversation_id' => null,
                    'message_id' => null,
                    'customer_id' => null,
                    'guest_id' => null,
                    'subject' => '[redacted by customer privacy request]',
                    'summary' => '[redacted by customer privacy request]',
                    'context_json' => null,
                    'contact_email' => null,
                    'contact_email_hash' => null,
                ],
                [$owner['sql'] => $owner['value']]
            );
            $result = $this->deleteRows($rows);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $this->deleteAttachmentDirectories($rows);
        return $result;
    }

    /** @return array{conversations:int,messages:int} */
    public function eraseExpired(string $updatedBefore, ?int $storeId = null, ?int $websiteId = null): array
    {
        $connection = $this->resource->getConnection();
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $select = $connection->select()
            ->from($conversationTable, ['conversation_id', 'customer_id', 'guest_id'])
            ->where('updated_at < ?', $updatedBefore)
            ->order('conversation_id ASC')
            ->limit(self::RETENTION_BATCH_SIZE);
        if ($storeId !== null) {
            $select->where('store_id = ?', $storeId);
        }
        if ($websiteId !== null) {
            $select->where('website_id = ?', $websiteId);
        }
        $rows = $connection->fetchAll($select);
        if (!is_array($rows) || $rows === []) {
            return ['conversations' => 0, 'messages' => 0];
        }

        $connection->beginTransaction();
        try {
            $result = $this->deleteRows($rows);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $this->deleteAttachmentDirectories($rows);
        return $result;
    }

    /**
     * @param array<string, int|string> $condition
     * @return array<int, array<string, mixed>>
     */
    private function fetchConversationRows(array $condition): array
    {
        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from(
                $this->resource->getTableName('afd_ai_conversation'),
                ['conversation_id', 'customer_id', 'guest_id']
            );
        foreach ($condition as $sql => $value) {
            $select->where($sql, $value);
        }

        $rows = $connection->fetchAll($select);
        return is_array($rows) ? $rows : [];
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @return array{conversations:int,messages:int}
     */
    private function deleteRows(array $rows): array
    {
        $conversationIds = array_values(array_filter(array_map(
            static fn (array $row): int => (int)($row['conversation_id'] ?? 0),
            $rows
        )));
        if ($conversationIds === []) {
            return ['conversations' => 0, 'messages' => 0];
        }

        $connection = $this->resource->getConnection();
        $deletedMessages = $connection->delete(
            $this->resource->getTableName('afd_ai_message'),
            ['conversation_id IN (?)' => $conversationIds]
        );
        $deletedConversations = $connection->delete(
            $this->resource->getTableName('afd_ai_conversation'),
            ['conversation_id IN (?)' => $conversationIds]
        );

        return ['conversations' => $deletedConversations, 'messages' => $deletedMessages];
    }

    /** @param array<int, array<string, mixed>> $rows */
    private function deleteAttachmentDirectories(array $rows): void
    {
        foreach ($rows as $row) {
            $conversationId = (int)($row['conversation_id'] ?? 0);
            $customerId = (int)($row['customer_id'] ?? 0);
            $guestId = strtolower(trim((string)($row['guest_id'] ?? '')));
            $ownerId = $customerId > 0 ? $customerId : $guestId;
            $this->attachmentStorage->deleteConversationAttachments($ownerId, $conversationId);
        }
    }

    /** @return array{sql:string,value:int|string}|null */
    private function ownerCondition(?int $customerId, ?string $guestId): ?array
    {
        if (($customerId ?? 0) > 0) {
            return ['sql' => 'customer_id = ?', 'value' => (int)$customerId];
        }

        $guestId = strtolower(trim((string)$guestId));
        return preg_match('/^[a-f0-9]{64}$/', $guestId)
            ? ['sql' => 'guest_id = ?', 'value' => $guestId]
            : null;
    }
}
