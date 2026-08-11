<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Afd\AI\Model\ChatMessagePayload;
use Magento\Framework\App\ResourceConnection;

class SupportTranscriptService
{
    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ChatMessagePayload $messagePayload
    ) {
    }

    /** @return array<int, array<string, mixed>> */
    public function load(int $conversationId, int $afterMessageId = 0, int $limit = 200, int $adminId = 0): array
    {
        if ($conversationId < 1) {
            return [];
        }
        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from($this->resource->getTableName('afd_ai_message'), [
                'entity_id', 'role', 'content', 'created_at', 'edited_at', 'deleted_at'
            ])
            ->where('conversation_id = ?', $conversationId)
            ->order('entity_id ASC')
            ->limit(max(1, min($limit, 200)));
        if ($afterMessageId > 0) {
            $select->where('entity_id > ?', $afterMessageId);
        }
        $messages = [];
        foreach ($connection->fetchAll($select) as $row) {
            $decoded = $this->messagePayload->decodeStoredMessage(
                (string)$row['role'],
                (string)$row['content'],
                (string)$row['entity_id']
            );
            $parts = array_filter($decoded['parts'] ?? [], static fn (array $part): bool => ($part['type'] ?? '') === 'text');
            $text = implode("\n\n", array_filter(array_map(
                static fn (array $part): string => trim((string)($part['raw'] ?? '')),
                $parts
            )));
            if ($text === '' && (string)$row['role'] === 'user') {
                $text = (string)$row['content'];
            }
            $source = (string)($decoded['source'] ?? '');
            $deleted = !empty($row['deleted_at']);
            $messages[] = [
                'entity_id' => (int)$row['entity_id'],
                'role' => (string)$row['role'] === 'user' ? 'user' : 'assistant',
                'text' => $deleted ? '' : mb_substr($text, 0, 12000),
                'created_at' => (string)$row['created_at'],
                'edited_at' => (string)($row['edited_at'] ?? ''),
                'deleted_at' => (string)($row['deleted_at'] ?? ''),
                'is_edited' => !$deleted && !empty($row['edited_at']),
                'is_deleted' => $deleted,
                'source' => $source,
                'sender_label' => $source === 'support_agent'
                    ? (string)($decoded['sender_label'] ?? 'Support team')
                    : ((string)$row['role'] === 'user' ? 'Customer' : 'AI Assistant'),
                'can_mutate' => !$deleted
                    && $adminId > 0
                    && $source === 'support_agent'
                    && (int)($decoded['admin_id'] ?? 0) === $adminId,
            ];
        }
        return $messages;
    }
}
