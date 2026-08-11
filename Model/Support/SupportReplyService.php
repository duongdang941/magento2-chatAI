<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Afd\AI\Model\ChatMessagePayload;
use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Exception\LocalizedException;

class SupportReplyService
{
    private const CLOSED_STATUSES = ['resolved', 'closed'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ChatMessagePayload $messagePayload,
        private readonly ActionRateLimiter $rateLimiter,
        private readonly SupportCaseNotifier $notifier,
        private readonly SupportMessagePublisher $publisher
    ) {
    }

    /** @return array{message_id:int,duplicate:bool} */
    public function reply(int $caseId, int $adminId, string $adminName, string $reply): array
    {
        $reply = mb_substr(trim($reply), 0, 4000);
        if ($caseId < 1 || $adminId < 1 || $reply === '') {
            throw new LocalizedException(__('Enter a reply before sending.'));
        }

        $admission = $this->rateLimiter->consume(
            'support_reply',
            sprintf('admin:%d:case:%d', $adminId, $caseId),
            20,
            60
        );
        if (!$admission['allowed']) {
            throw new LocalizedException(__('Too many replies were sent. Please wait and try again.'));
        }

        $connection = $this->resource->getConnection();
        $caseTable = $this->resource->getTableName('afd_ai_support_case');
        $messageTable = $this->resource->getTableName('afd_ai_message');
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $connection->beginTransaction();
        try {
            $case = $connection->fetchRow(
                $connection->select()->from($caseTable)->where('entity_id = ?', $caseId)->forUpdate(true)
            );
            if (!is_array($case) || $case === []) {
                throw new LocalizedException(__('The support case no longer exists.'));
            }
            if (in_array((string)$case['status'], self::CLOSED_STATUSES, true)) {
                throw new LocalizedException(__('Reopen this case before sending another reply.'));
            }
            $conversationId = (int)($case['conversation_id'] ?? 0);
            if ($conversationId < 1) {
                throw new LocalizedException(__('This case is no longer linked to a conversation.'));
            }

            $duplicateId = $this->findRecentDuplicate($conversationId, $adminId, $reply);
            if ($duplicateId > 0) {
                $connection->commit();
                return ['message_id' => $duplicateId, 'duplicate' => true];
            }

            $senderLabel = mb_substr(trim($adminName) ?: (string)__('Support team'), 0, 80);
            $content = $this->messagePayload->encodeAssistantParts(
                [['type' => 'text', 'raw' => $reply]],
                ['source' => 'support_agent', 'sender_label' => $senderLabel, 'admin_id' => $adminId]
            );
            $connection->insert($messageTable, [
                'session_id' => 'admin-support:' . $adminId,
                'customer_id' => ((int)($case['customer_id'] ?? 0)) > 0 ? (int)$case['customer_id'] : null,
                'conversation_id' => $conversationId,
                'role' => 'assistant',
                'content' => $content,
                'attachment' => null,
            ]);
            $messageId = (int)$connection->lastInsertId($messageTable);
            $now = gmdate('Y-m-d H:i:s');
            $connection->update($caseTable, [
                'assigned_admin_id' => $adminId,
                'status' => 'waiting_customer',
                'takeover_state' => 'active',
                'admin_unread_count' => 0,
                'customer_unread_count' => new \Zend_Db_Expr('customer_unread_count + 1'),
                'last_admin_message_at' => $now,
                'resolved_at' => null,
                'updated_at' => $now,
            ], ['entity_id = ?' => $caseId]);
            $connection->update($conversationTable, ['updated_at' => $now], ['conversation_id = ?' => $conversationId]);
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }

        $case['status'] = 'waiting_customer';
        $case['assigned_admin_id'] = $adminId;
        // Realtime delivery is part of the chat path and must not wait for the
        // slower email transport. The database commit above remains the source
        // of truth if either notification channel is unavailable.
        $this->publisher->publish($case, $messageId);
        $this->notifier->notifyCustomerReply($case, $reply);

        return ['message_id' => $messageId, 'duplicate' => false];
    }

    private function findRecentDuplicate(int $conversationId, int $adminId, string $reply): int
    {
        $connection = $this->resource->getConnection();
        $row = $connection->fetchRow(
            $connection->select()
                ->from($this->resource->getTableName('afd_ai_message'), ['entity_id', 'content', 'created_at'])
                ->where('conversation_id = ?', $conversationId)
                ->where('role = ?', 'assistant')
                ->order('entity_id DESC')
                ->limit(1)
        );
        if (!is_array($row) || strtotime((string)$row['created_at']) < time() - 30) {
            return 0;
        }
        $payload = json_decode((string)$row['content'], true);
        return is_array($payload)
            && ($payload['source'] ?? '') === 'support_agent'
            && (int)($payload['admin_id'] ?? 0) === $adminId
            && hash_equals(trim((string)($payload['text'] ?? '')), $reply)
                ? (int)$row['entity_id']
                : 0;
    }
}
