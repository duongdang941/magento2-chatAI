<?php
declare(strict_types=1);

namespace Afd\AI\Model\Quality;

use Afd\AI\Model\Conversation\ConversationIdentity;
use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Framework\App\ResourceConnection;

class FeedbackService
{
    private const RATINGS = ['positive', 'negative'];
    private const REASONS = ['incorrect', 'irrelevant', 'outdated', 'unsafe', 'tool_failed', 'other'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ConversationIdentity $conversationIdentity,
        private readonly ActionRateLimiter $rateLimiter
    ) {
    }

    /** @return array<string, mixed> */
    public function save(
        int $conversationId,
        int $messageId,
        ?int $customerId,
        ?string $guestId,
        string $rating,
        string $reason = '',
        string $comment = ''
    ): array {
        $rating = strtolower(trim($rating));
        $reason = strtolower(trim($reason));
        $comment = trim($comment);
        if (!in_array($rating, self::RATINGS, true)) {
            return ['status' => 'error', 'message' => __('Choose a valid rating.')->render()];
        }
        if ($reason !== '' && !in_array($reason, self::REASONS, true)) {
            $reason = 'other';
        }
        if (!$this->conversationIdentity->ownsAssistantMessage(
            $conversationId,
            $messageId,
            $customerId,
            $guestId
        )) {
            return ['status' => 'error', 'message' => __('That response is no longer available.')->render()];
        }

        $identity = ($customerId ?? 0) > 0 ? 'customer:' . $customerId : 'guest:' . $guestId;
        $throttle = $this->rateLimiter->consume('feedback', $identity, 30, 3600);
        if (!$throttle['allowed']) {
            return [
                'status' => 'rate_limited',
                'retry_after' => $throttle['retry_after'],
                'message' => __('Please wait before rating another response.')->render(),
            ];
        }

        $now = gmdate('Y-m-d H:i:s');
        $this->resource->getConnection()->insertOnDuplicate(
            $this->resource->getTableName('afd_ai_feedback'),
            [
                'conversation_id' => $conversationId,
                'message_id' => $messageId,
                'customer_id' => ($customerId ?? 0) > 0 ? $customerId : null,
                'guest_id' => ($customerId ?? 0) > 0 ? null : strtolower((string)$guestId),
                'rating' => $rating,
                'reason' => $reason !== '' ? $reason : null,
                'comment' => $comment !== '' ? mb_substr($comment, 0, 1000) : null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            ['rating', 'reason', 'comment', 'updated_at']
        );

        return ['status' => 'success', 'rating' => $rating];
    }

    /**
     * Remove a rating when the shopper presses the selected reaction again.
     *
     * @return array<string, mixed>
     */
    public function clear(
        int $conversationId,
        int $messageId,
        ?int $customerId,
        ?string $guestId
    ): array {
        if (!$this->conversationIdentity->ownsAssistantMessage(
            $conversationId,
            $messageId,
            $customerId,
            $guestId
        )) {
            return ['status' => 'error', 'message' => __('That response is no longer available.')->render()];
        }

        $identity = ($customerId ?? 0) > 0 ? 'customer:' . $customerId : 'guest:' . $guestId;
        $throttle = $this->rateLimiter->consume('feedback', $identity, 30, 3600);
        if (!$throttle['allowed']) {
            return [
                'status' => 'rate_limited',
                'retry_after' => $throttle['retry_after'],
                'message' => __('Please wait before changing another response rating.')->render(),
            ];
        }

        $connection = $this->resource->getConnection();
        $conditions = [
            $connection->quoteInto('conversation_id = ?', $conversationId),
            $connection->quoteInto('message_id = ?', $messageId),
        ];
        if (($customerId ?? 0) > 0) {
            $conditions[] = $connection->quoteInto('customer_id = ?', $customerId);
        } else {
            $conditions[] = $connection->quoteInto('guest_id = ?', strtolower((string)$guestId));
        }
        $connection->delete(
            $this->resource->getTableName('afd_ai_feedback'),
            implode(' AND ', $conditions)
        );

        return ['status' => 'success', 'rating' => null];
    }
}
