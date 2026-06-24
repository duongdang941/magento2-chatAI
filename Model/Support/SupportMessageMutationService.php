<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Afd\AI\Model\ChatMessagePayload;
use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Exception\LocalizedException;
use Magento\Store\Model\StoreManagerInterface;

class SupportMessageMutationService
{
    private const CLOSED_STATUSES = ['resolved', 'closed'];
    private const OPERATIONS = ['edit', 'delete'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ChatMessagePayload $messagePayload,
        private readonly SupportMessagePublisher $publisher,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /** @return array<string, mixed> */
    public function mutateForCustomer(
        int $conversationId,
        int $messageId,
        string $operation,
        string $content,
        ?int $customerId,
        ?string $guestId
    ): array {
        return $this->mutate(
            $conversationId,
            0,
            $messageId,
            $operation,
            $content,
            'customer',
            max(0, (int)$customerId),
            strtolower(trim((string)$guestId))
        );
    }

    /** @return array<string, mixed> */
    public function mutateForAdmin(
        int $caseId,
        int $messageId,
        string $operation,
        string $content,
        int $adminId
    ): array {
        return $this->mutate(0, $caseId, $messageId, $operation, $content, 'admin', $adminId, '');
    }

    /** @return array<string, mixed> */
    private function mutate(
        int $conversationId,
        int $caseId,
        int $messageId,
        string $operation,
        string $content,
        string $actorType,
        int $actorId,
        string $guestId
    ): array {
        $operation = strtolower(trim($operation));
        $content = mb_substr(trim($content), 0, 4000);
        if ($messageId < 1 || !in_array($operation, self::OPERATIONS, true)) {
            throw new LocalizedException(__('Choose a valid message action.'));
        }
        if ($operation === 'edit' && $content === '') {
            throw new LocalizedException(__('A message cannot be empty.'));
        }
        if ($actorType === 'admin' && $actorId < 1) {
            throw new LocalizedException(__('The administrator session could not be verified.'));
        }
        if ($actorType === 'customer' && $actorId < 1 && !preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            throw new LocalizedException(__('The customer session could not be verified.'));
        }

        $connection = $this->resource->getConnection();
        $caseTable = $this->resource->getTableName('afd_ai_support_case');
        $messageTable = $this->resource->getTableName('afd_ai_message');
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $connection->beginTransaction();
        try {
            $caseSelect = $connection->select()
                ->from(['support_case' => $caseTable])
                ->joinInner(
                    ['conversation' => $conversationTable],
                    "conversation.conversation_id = support_case.conversation_id"
                        . " AND conversation.conversation_type = 'support'",
                    []
                )
                ->forUpdate(true)
                ->limit(1);
            if ($caseId > 0) {
                $caseSelect->where('support_case.entity_id = ?', $caseId);
            } else {
                $caseSelect->where('support_case.conversation_id = ?', $conversationId);
            }
            $store = $this->storeManager->getStore();
            $caseSelect
                ->where('conversation.store_id = ?', (int)$store->getId())
                ->where('conversation.website_id = ?', (int)$store->getWebsiteId());
            $case = $connection->fetchRow($caseSelect);
            if (!is_array($case) || $case === []) {
                throw new LocalizedException(__('The support ticket no longer exists.'));
            }
            if (in_array((string)($case['status'] ?? ''), self::CLOSED_STATUSES, true)) {
                throw new LocalizedException(__('Closed tickets are read-only.'));
            }
            $conversationId = (int)($case['conversation_id'] ?? 0);
            $this->assertActorOwnsCase($case, $actorType, $actorId, $guestId);

            $message = $connection->fetchRow(
                $connection->select()
                    ->from($messageTable)
                    ->where('entity_id = ?', $messageId)
                    ->where('conversation_id = ?', $conversationId)
                    ->forUpdate(true)
            );
            if (!is_array($message) || $message === []) {
                throw new LocalizedException(__('The message no longer exists.'));
            }
            $decoded = $this->messagePayload->decodeStoredMessage(
                (string)$message['role'],
                (string)$message['content'],
                (string)$messageId
            );
            $this->assertActorOwnsMessage($message, $decoded, $actorType, $actorId);

            if (!empty($message['deleted_at'])) {
                if ($operation === 'edit') {
                    throw new LocalizedException(__('Deleted messages cannot be edited.'));
                }
                $result = $this->buildResult($message, $decoded, 'delete');
                $connection->commit();
                return $result;
            }

            $now = gmdate('Y-m-d H:i:s');
            $update = [
                'original_content' => new \Zend_Db_Expr('COALESCE(original_content, content)'),
            ];
            if ($operation === 'edit') {
                $update['content'] = $actorType === 'admin'
                    ? $this->messagePayload->encodeAssistantParts(
                        [['type' => 'text', 'raw' => $content]],
                        [
                            'source' => 'support_agent',
                            'sender_label' => (string)($decoded['sender_label'] ?? 'Support team'),
                            'admin_id' => $actorId,
                        ]
                    )
                    : $content;
                $update['edited_at'] = $now;
            } else {
                $update['deleted_at'] = $now;
            }
            $connection->update($messageTable, $update, ['entity_id = ?' => $messageId]);

            $caseUpdate = ['updated_at' => $now];
            if ($actorType === 'admin') {
                $caseUpdate['customer_unread_count'] = new \Zend_Db_Expr('customer_unread_count + 1');
            } else {
                $caseUpdate['admin_unread_count'] = new \Zend_Db_Expr('admin_unread_count + 1');
            }
            if ((int)($case['message_id'] ?? 0) === $messageId && $actorType === 'customer') {
                $caseUpdate['summary'] = $operation === 'delete'
                    ? (string)__('Message deleted by customer')
                    : $content;
            }
            $connection->update($caseTable, $caseUpdate, ['entity_id = ?' => (int)$case['entity_id']]);
            $connection->update($conversationTable, ['updated_at' => $now], ['conversation_id = ?' => $conversationId]);

            $message = array_merge($message, $update, [
                'content' => $operation === 'edit' ? (string)$update['content'] : (string)$message['content'],
                'edited_at' => $operation === 'edit' ? $now : ($message['edited_at'] ?? null),
                'deleted_at' => $operation === 'delete' ? $now : ($message['deleted_at'] ?? null),
            ]);
            $decoded = $this->messagePayload->decodeStoredMessage(
                (string)$message['role'],
                (string)$message['content'],
                (string)$messageId
            );
            $result = $this->buildResult($message, $decoded, $operation);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $this->publisher->publishMutation($case, $result);
        return $result;
    }

    /** @param array<string, mixed> $case */
    private function assertActorOwnsCase(array $case, string $actorType, int $actorId, string $guestId): void
    {
        if ($actorType === 'admin') {
            return;
        }
        $caseCustomerId = (int)($case['customer_id'] ?? 0);
        $owned = $actorId > 0
            ? $caseCustomerId === $actorId
            : $caseCustomerId === 0 && hash_equals((string)($case['guest_id'] ?? ''), $guestId);
        if (!$owned) {
            throw new LocalizedException(__('You cannot change this support message.'));
        }
    }

    /** @param array<string, mixed> $message @param array<string, mixed> $decoded */
    private function assertActorOwnsMessage(array $message, array $decoded, string $actorType, int $actorId): void
    {
        if ($actorType === 'customer' && (string)$message['role'] === 'user') {
            return;
        }
        if ($actorType === 'admin'
            && (string)$message['role'] === 'assistant'
            && (string)($decoded['source'] ?? '') === 'support_agent'
            && (int)($decoded['admin_id'] ?? 0) === $actorId) {
            return;
        }
        throw new LocalizedException(__('You can only change messages that you sent.'));
    }

    /** @param array<string, mixed> $message @param array<string, mixed> $decoded @return array<string, mixed> */
    private function buildResult(array $message, array $decoded, string $operation): array
    {
        return [
            'status' => 'success',
            'operation' => $operation,
            'message_id' => (int)$message['entity_id'],
            'conversation_id' => (int)$message['conversation_id'],
            'content' => !empty($message['deleted_at']) ? '' : mb_substr((string)($decoded['content'] ?? ''), 0, 4000),
            'edited_at' => (string)($message['edited_at'] ?? ''),
            'deleted_at' => (string)($message['deleted_at'] ?? ''),
        ];
    }
}
