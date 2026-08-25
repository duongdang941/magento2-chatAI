<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Privacy;

use Afd\AI\Model\ChatAttachmentStorage;
use Afd\AI\Model\Privacy\ConversationDataEraser;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class ConversationDataEraserTest extends TestCase
{
    public function testPrivacyEraseDeletesMessagesBeforeConversationsAndCleansAttachments(): void
    {
        $select = $this->createMock(Select::class);
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();

        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('fetchAll')->willReturn([
            ['conversation_id' => 7, 'customer_id' => 42, 'guest_id' => null],
        ]);
        $connection->expects(self::once())->method('beginTransaction');
        $connection->expects(self::once())->method('update')->with(
            'afd_ai_support_case',
            self::callback(static fn (array $data): bool => $data['contact_email_hash'] === null),
            ['customer_id = ?' => 42]
        );
        $connection->expects(self::exactly(4))->method('delete')->willReturnCallback(
            static function (string $table, array $condition): int {
                if ($table === 'afd_ai_message' || $table === 'afd_ai_conversation') {
                    self::assertSame(['conversation_id IN (?)' => [7]], $condition);
                    return $table === 'afd_ai_message' ? 3 : 1;
                }
                // Telemetry keyed to the erased owner is purged best-effort.
                self::assertContains($table, ['afd_ai_analytics_event', 'afd_ai_guardrail_audit']);
                self::assertSame(['customer_id = ?' => 42], $condition);
                return 5;
            }
        );
        $connection->expects(self::once())->method('commit');

        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnArgument(0);
        $attachments = $this->createMock(ChatAttachmentStorage::class);
        $attachments->expects(self::once())->method('deleteConversationAttachments')->with(42, 7);

        $result = (new ConversationDataEraser(
            $resource,
            $attachments,
            $this->createMock(LoggerInterface::class)
        ))->eraseOwned(42, null);

        self::assertSame(['conversations' => 1, 'messages' => 3], $result);
    }

    public function testInvalidGuestIdentityCannotDeleteAnything(): void
    {
        $resource = $this->createMock(ResourceConnection::class);
        $resource->expects(self::never())->method('getConnection');
        $eraser = new ConversationDataEraser(
            $resource,
            $this->createMock(ChatAttachmentStorage::class),
            $this->createMock(LoggerInterface::class)
        );

        self::assertSame(
            ['conversations' => 0, 'messages' => 0],
            $eraser->eraseOwned(null, 'not-a-session-hash')
        );
    }
}
