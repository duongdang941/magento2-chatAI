<?php
declare(strict_types=1);

namespace Afd\AI\Model\Privacy;

use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Encryption\EncryptorInterface;

class ChatDataService
{
    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly EncryptorInterface $encryptor,
        private readonly ActionRateLimiter $rateLimiter,
        private readonly ConversationDataEraser $conversationDataEraser
    ) {
    }

    /** @return array<string, mixed> */
    public function export(?int $customerId, ?string $guestId): array
    {
        $owner = $this->ownerCondition($customerId, $guestId);
        if ($owner === null) {
            return ['status' => 'error', 'message' => __('The chat identity could not be verified.')->render()];
        }
        $connection = $this->resource->getConnection();
        $conversationTable = $this->resource->getTableName('afd_ai_conversation');
        $messageTable = $this->resource->getTableName('afd_ai_message');
        $feedbackTable = $this->resource->getTableName('afd_ai_feedback');
        $caseTable = $this->resource->getTableName('afd_ai_support_case');

        $conversations = $connection->fetchAll(
            $connection->select()->from($conversationTable)->where($owner['sql'], $owner['value'])->order('conversation_id ASC')
        );
        $conversationIds = array_map('intval', array_column($conversations, 'conversation_id'));
        $messages = $conversationIds ? $connection->fetchAll(
            $connection->select()->from($messageTable, ['entity_id', 'conversation_id', 'role', 'content', 'attachment', 'created_at'])
                ->where('conversation_id IN (?)', $conversationIds)->order('entity_id ASC')
        ) : [];
        $feedback = $conversationIds ? $connection->fetchAll(
            $connection->select()->from($feedbackTable, ['conversation_id', 'message_id', 'rating', 'reason', 'comment', 'created_at', 'updated_at'])
                ->where('conversation_id IN (?)', $conversationIds)->order('feedback_id ASC')
        ) : [];
        $cases = $connection->fetchAll(
            $connection->select()->from($caseTable, ['public_id', 'category', 'priority', 'status', 'subject', 'summary', 'contact_email', 'created_at', 'updated_at', 'resolved_at'])
                ->where($owner['sql'], $owner['value'])->order('entity_id ASC')
        );
        foreach ($cases as &$case) {
            $case['contact_email'] = $case['contact_email'] ? $this->decrypt((string)$case['contact_email']) : null;
        }
        unset($case);

        return [
            'status' => 'success',
            'exported_at' => gmdate(DATE_ATOM),
            'conversations' => $conversations,
            'messages' => $messages,
            'feedback' => $feedback,
            'support_cases' => $cases,
        ];
    }

    /** @return array<string, mixed> */
    public function delete(?int $customerId, ?string $guestId): array
    {
        $owner = $this->ownerCondition($customerId, $guestId);
        if ($owner === null) {
            return ['status' => 'error', 'message' => __('The chat identity could not be verified.')->render()];
        }
        $identity = ($customerId ?? 0) > 0 ? 'customer:' . $customerId : 'guest:' . $guestId;
        $throttle = $this->rateLimiter->consume('privacy_delete', $identity, 2, 86400);
        if (!$throttle['allowed']) {
            return ['status' => 'rate_limited', 'retry_after' => $throttle['retry_after'], 'message' => __('Please wait before requesting another deletion.')->render()];
        }

        $deleted = $this->conversationDataEraser->eraseOwned($customerId, $guestId);
        return [
            'status' => 'success',
            'deleted_conversations' => $deleted['conversations'],
            'deleted_messages' => $deleted['messages'],
            'message' => __('Your Store Assistant chat data was deleted.')->render(),
        ];
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

    private function decrypt(string $value): string
    {
        try {
            return $this->encryptor->decrypt($value);
        } catch (\Throwable) {
            return '';
        }
    }
}
