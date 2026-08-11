<?php
declare(strict_types=1);

namespace Afd\AI\Model\Conversation;

use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\ChatMessagePayload;
use Magento\Framework\App\ResourceConnection;

/**
 * Loads a bounded, cursor-based page of a customer's conversation messages.
 */
class MessagePageLoader
{
    private const DEFAULT_PAGE_SIZE = 50;
    private const MAX_PAGE_SIZE = 100;

    private ConversationRepositoryInterface $conversationRepository;
    private ResourceConnection $resourceConnection;
    private ChatMessagePayload $chatMessagePayload;

    public function __construct(
        ConversationRepositoryInterface $conversationRepository,
        ResourceConnection $resourceConnection,
        ChatMessagePayload $chatMessagePayload
    ) {
        $this->conversationRepository = $conversationRepository;
        $this->resourceConnection = $resourceConnection;
        $this->chatMessagePayload = $chatMessagePayload;
    }

    /**
     * @return array{messages: array<int, array<string, mixed>>, has_more: bool, next_before_message_id: int|null}|null
     */
    public function load(
        int $conversationId,
        int $customerId,
        ?int $beforeMessageId = null,
        int $pageSize = self::DEFAULT_PAGE_SIZE
    ): ?array {
        if ($conversationId < 1 || $customerId < 1) {
            return null;
        }

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
        } catch (\Exception $exception) {
            return null;
        }

        if ((int)$conversation->getCustomerId() !== $customerId) {
            return null;
        }

        $pageSize = max(1, min($pageSize, self::MAX_PAGE_SIZE));
        $connection = $this->resourceConnection->getConnection();
        $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
        $feedbackTable = $this->resourceConnection->getTableName('afd_ai_feedback');
        $select = $connection->select()
            ->from(['message' => $messageTable], [
                'entity_id', 'role', 'content', 'attachment', 'created_at', 'edited_at', 'deleted_at'
            ])
            ->joinLeft(['feedback' => $feedbackTable], 'feedback.message_id = message.entity_id', [
                'feedback_rating' => 'rating',
                'feedback_reason' => 'reason',
                'feedback_comment' => 'comment',
            ])
            ->where('message.conversation_id = ?', $conversationId)
            ->order('message.entity_id DESC')
            ->limit($pageSize + 1);

        if ($beforeMessageId !== null && $beforeMessageId > 0) {
            $select->where('entity_id < ?', $beforeMessageId);
        }

        $rows = $connection->fetchAll($select);
        $hasMore = count($rows) > $pageSize;
        if ($hasMore) {
            array_pop($rows);
        }

        $rows = array_reverse($rows);
        $messages = [];
        foreach ($rows as $row) {
            $messageId = (string)$row['entity_id'];
            $decodedMessage = $this->chatMessagePayload->decodeStoredMessage(
                (string)$row['role'],
                (string)$row['content'],
                $messageId
            );
            $attachments = $this->decodeAttachments((string)($row['attachment'] ?? ''));
            $deleted = !empty($row['deleted_at']);
            if ($deleted) {
                $decodedMessage['content'] = '';
                $decodedMessage['parts'] = [];
                $attachments = [];
            }
            $messages[] = [
                'entity_id' => (int)$row['entity_id'],
                'role' => (string)$row['role'],
                'content' => $decodedMessage['content'],
                'parts' => $decodedMessage['parts'],
                'interrupted' => $decodedMessage['interrupted'],
                'stopped_after_seconds' => $decodedMessage['stopped_after_seconds'],
                'source' => $decodedMessage['source'] ?? '',
                'sender_label' => $decodedMessage['sender_label'] ?? '',
                // attachment is retained for clients during the rolling deployment. New clients use attachments.
                'attachment' => $attachments[0] ?? null,
                'attachments' => $attachments,
                'created_at' => $row['created_at'],
                'edited_at' => (string)($row['edited_at'] ?? ''),
                'deleted_at' => (string)($row['deleted_at'] ?? ''),
                'is_edited' => !$deleted && !empty($row['edited_at']),
                'is_deleted' => $deleted,
                'feedback' => (string)($row['feedback_rating'] ?? ''),
                'feedback_reason' => (string)($row['feedback_reason'] ?? ''),
                'feedback_comment' => (string)($row['feedback_comment'] ?? '')
            ];
        }

        return [
            'messages' => $messages,
            'has_more' => $hasMore,
            'next_before_message_id' => $hasMore && $messages
                ? (int)$messages[0]['entity_id']
                : null
        ];
    }

    /** @return array{messages: array<int, array<string, mixed>>, has_more: bool, next_before_message_id: int|null}|null */
    public function loadGuest(
        int $conversationId,
        string $guestId,
        ?int $beforeMessageId = null,
        int $pageSize = self::DEFAULT_PAGE_SIZE
    ): ?array {
        if ($conversationId < 1 || !preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            return null;
        }

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
        } catch (\Exception $exception) {
            return null;
        }

        if (!hash_equals((string)$conversation->getData('guest_id'), $guestId)) {
            return null;
        }

        return $this->loadRows($conversationId, $beforeMessageId, $pageSize);
    }

    /** @return array{messages: array<int, array<string, mixed>>, has_more: bool, next_before_message_id: int|null} */
    private function loadRows(int $conversationId, ?int $beforeMessageId, int $pageSize): array
    {
        $pageSize = max(1, min($pageSize, self::MAX_PAGE_SIZE));
        $connection = $this->resourceConnection->getConnection();
        $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
        $feedbackTable = $this->resourceConnection->getTableName('afd_ai_feedback');
        $select = $connection->select()
            ->from(['message' => $messageTable], [
                'entity_id', 'role', 'content', 'attachment', 'created_at', 'edited_at', 'deleted_at'
            ])
            ->joinLeft(['feedback' => $feedbackTable], 'feedback.message_id = message.entity_id', [
                'feedback_rating' => 'rating',
                'feedback_reason' => 'reason',
                'feedback_comment' => 'comment',
            ])
            ->where('message.conversation_id = ?', $conversationId)
            ->order('message.entity_id DESC')
            ->limit($pageSize + 1);

        if ($beforeMessageId !== null && $beforeMessageId > 0) {
            $select->where('entity_id < ?', $beforeMessageId);
        }

        $rows = $connection->fetchAll($select);
        $hasMore = count($rows) > $pageSize;
        if ($hasMore) {
            array_pop($rows);
        }

        $rows = array_reverse($rows);
        $messages = [];
        foreach ($rows as $row) {
            $messageId = (string)$row['entity_id'];
            $decodedMessage = $this->chatMessagePayload->decodeStoredMessage(
                (string)$row['role'],
                (string)$row['content'],
                $messageId
            );
            $attachments = $this->decodeAttachments((string)($row['attachment'] ?? ''));
            $deleted = !empty($row['deleted_at']);
            if ($deleted) {
                $decodedMessage['content'] = '';
                $decodedMessage['parts'] = [];
                $attachments = [];
            }
            $messages[] = [
                'entity_id' => (int)$row['entity_id'],
                'role' => (string)$row['role'],
                'content' => $decodedMessage['content'],
                'parts' => $decodedMessage['parts'],
                'interrupted' => $decodedMessage['interrupted'],
                'stopped_after_seconds' => $decodedMessage['stopped_after_seconds'],
                'source' => $decodedMessage['source'] ?? '',
                'sender_label' => $decodedMessage['sender_label'] ?? '',
                'attachment' => $attachments[0] ?? null,
                'attachments' => $attachments,
                'created_at' => $row['created_at'],
                'edited_at' => (string)($row['edited_at'] ?? ''),
                'deleted_at' => (string)($row['deleted_at'] ?? ''),
                'is_edited' => !$deleted && !empty($row['edited_at']),
                'is_deleted' => $deleted,
                'feedback' => (string)($row['feedback_rating'] ?? ''),
                'feedback_reason' => (string)($row['feedback_reason'] ?? ''),
                'feedback_comment' => (string)($row['feedback_comment'] ?? '')
            ];
        }

        return [
            'messages' => $messages,
            'has_more' => $hasMore,
            'next_before_message_id' => $hasMore && $messages ? (int)$messages[0]['entity_id'] : null
        ];
    }

    /**
     * Only expose metadata generated by ChatAttachmentStorage. This prevents malformed legacy
     * values from becoming an image URL in the customer's browser.
     *
     * @return array<int, array{name:string,mime_type:string,size:int,url:string}>
     */
    private function decodeAttachments(string $storedAttachment): array
    {
        if ($storedAttachment === '') {
            return [];
        }

        try {
            $attachment = json_decode($storedAttachment, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            return [];
        }

        if (!is_array($attachment)) {
            return [];
        }

        $items = is_array($attachment['items'] ?? null) ? $attachment['items'] : [$attachment];
        $normalizedAttachments = [];
        foreach (array_slice($items, 0, 4) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $url = trim((string)($item['url'] ?? ''));
            $mimeType = strtolower(trim((string)($item['mime_type'] ?? '')));
            if ($url === '' || !in_array($mimeType, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                continue;
            }

            $normalizedAttachments[] = [
                'name' => trim((string)($item['name'] ?? 'image')) ?: 'image',
                'mime_type' => $mimeType,
                'size' => max(0, (int)($item['size'] ?? 0)),
                'url' => $url
            ];
        }

        return $normalizedAttachments;
    }
}
