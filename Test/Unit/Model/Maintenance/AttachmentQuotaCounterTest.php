<?php
declare(strict_types=1);
namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\AttachmentQuotaCounter;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use PHPUnit\Framework\TestCase;

final class AttachmentQuotaCounterTest extends TestCase
{
    public function testInitializeGlobalWritesAZeroReservationRow(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->expects(self::once())->method('insertOnDuplicate')->with(
            'afd_ai_attachment_quota',
            self::callback(static fn (array $row): bool => $row['scope_type'] === 'global'
                && $row['scope_key'] === 'module'
                && $row['used_bytes'] === 123
                && $row['reserved_bytes'] === 0),
            ['updated_at']
        );
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_attachment_quota')->willReturn('afd_ai_attachment_quota');
        (new AttachmentQuotaCounter($resource))->initializeGlobal(123);
    }

    public function testGlobalInitializationCanBeDetected(): void
    {
        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('limit')->willReturnSelf();
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->expects(self::once())->method('fetchOne')->with($select)->willReturn(1);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_attachment_quota')->willReturn('afd_ai_attachment_quota');
        self::assertTrue((new AttachmentQuotaCounter($resource))->isGlobalInitialized());
    }
}
