<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Quality;

use Afd\AI\Model\Conversation\ConversationIdentity;
use Afd\AI\Model\Quality\FeedbackService;
use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use PHPUnit\Framework\TestCase;

class FeedbackServiceTest extends TestCase
{
    public function testClearsAnOwnedGuestRating(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('quoteInto')
            ->willReturnCallback(static fn (string $condition, $value): string => str_replace('?', (string)$value, $condition));
        $connection->expects(self::once())
            ->method('delete')
            ->with(
                'afd_ai_feedback',
                'conversation_id = 12 AND message_id = 34 AND guest_id = guest-hash'
            );

        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_feedback')->willReturn('afd_ai_feedback');

        $identity = $this->createMock(ConversationIdentity::class);
        $identity->expects(self::once())
            ->method('ownsAssistantMessage')
            ->with(12, 34, null, 'GUEST-HASH')
            ->willReturn(true);

        $rateLimiter = $this->createMock(ActionRateLimiter::class);
        $rateLimiter->expects(self::once())
            ->method('consume')
            ->with('feedback', 'guest:GUEST-HASH', 30, 3600)
            ->willReturn(['allowed' => true, 'retry_after' => 0]);

        $service = new FeedbackService($resource, $identity, $rateLimiter);

        self::assertSame(
            ['status' => 'success', 'rating' => null],
            $service->clear(12, 34, null, 'GUEST-HASH')
        );
    }

    public function testDoesNotDeleteFeedbackOutsideTheOwnedConversation(): void
    {
        $resource = $this->createMock(ResourceConnection::class);
        $identity = $this->createMock(ConversationIdentity::class);
        $identity->method('ownsAssistantMessage')->willReturn(false);
        $rateLimiter = $this->createMock(ActionRateLimiter::class);
        $rateLimiter->expects(self::never())->method('consume');

        $service = new FeedbackService($resource, $identity, $rateLimiter);
        $result = $service->clear(12, 34, null, 'guest-hash');

        self::assertSame('error', $result['status']);
    }
}
