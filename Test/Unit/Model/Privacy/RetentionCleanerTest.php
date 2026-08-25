<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Privacy;

use Afd\AI\Model\Privacy\RetentionCleaner;
use Afd\AI\Model\Privacy\ConversationDataEraser;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use Magento\Store\Model\ScopeInterface;
use PHPUnit\Framework\TestCase;

class RetentionCleanerTest extends TestCase
{
    public function testUsesConfiguredRetentionAndDeletesOnlyResolvedCases(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('isTableExists')->willReturn(true);
        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('distinct')->willReturnSelf();
        $connection->method('select')->willReturn($select);
        // Scopes are derived from stored rows so deleted store views age out too.
        $connection->method('fetchAll')->willReturnOnConsecutiveCalls(
            [['store_id' => 1, 'website_id' => 1]],
            [['store_id' => 1, 'website_id' => 1]]
        );
        $connection->expects(self::once())->method('delete')->willReturn(2);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnArgument(0);
        $config = $this->createMock(ScopeConfigInterface::class);
        $config->method('getValue')->willReturnMap([
            ['afd_ai/privacy/conversation_retention_days', ScopeInterface::SCOPE_STORE, 1, '30'],
            ['afd_ai/privacy/resolved_case_retention_days', ScopeInterface::SCOPE_STORE, 1, '365'],
        ]);

        $eraser = $this->createMock(ConversationDataEraser::class);
        $eraser->expects(self::once())
            ->method('eraseExpired')
            ->with('2033-04-18 03:33:20', 1, 1)
            ->willReturn(['conversations' => 4, 'messages' => 12]);

        $result = (new RetentionCleaner($config, $eraser, $resource))->execute(2_000_000_000);
        self::assertSame(['conversations' => 4, 'messages' => 12, 'resolved_cases' => 2], $result);
    }

    public function testCoversStoreScopesThatNoLongerExistAsLiveViews(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('isTableExists')->willReturn(true);
        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('distinct')->willReturnSelf();
        $connection->method('select')->willReturn($select);
        // A deleted store view (id 44) still owns conversations in the table.
        $connection->method('fetchAll')->willReturnOnConsecutiveCalls(
            [['store_id' => 44, 'website_id' => 2]],
            []
        );
        $connection->expects(self::once())->method('delete')->willReturn(1);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnArgument(0);
        $config = $this->createMock(ScopeConfigInterface::class);
        $config->method('getValue')->willReturn('90');

        $eraser = $this->createMock(ConversationDataEraser::class);
        $eraser->expects(self::once())
            ->method('eraseExpired')
            ->with(self::anything(), 44, 2)
            ->willReturn(['conversations' => 2, 'messages' => 5]);

        $result = (new RetentionCleaner($config, $eraser, $resource))->execute(2_000_000_000);
        self::assertSame(['conversations' => 2, 'messages' => 5, 'resolved_cases' => 1], $result);
    }
}
