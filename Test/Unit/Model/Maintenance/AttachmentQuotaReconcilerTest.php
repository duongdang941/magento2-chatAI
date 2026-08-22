<?php
declare(strict_types=1);
namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\AttachmentQuotaReconciler;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Magento\Framework\Lock\LockManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class AttachmentQuotaReconcilerTest extends TestCase
{
    public function testBusyLockSkips(): void
    {
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(false);
        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects(self::once())->method('notice');
        $sut = new AttachmentQuotaReconciler(
            $this->createMock(Filesystem::class),
            $this->createMock(ResourceConnection::class),
            $lock,
            $logger
        );

        self::assertFalse($sut->execute()['reconciled']);
    }

    public function testReconcilesEmptyOwnersAndCreatesGlobalRow(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('search')->willReturn([]);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->with(DirectoryList::VAR_DIR)->willReturn($directory);
        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('forUpdate')->willReturnSelf();
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('fetchAll')->willReturn([]);
        $connection->method('fetchRow')->willReturn(null);
        $connection->expects(self::once())->method('beginTransaction');
        $connection->expects(self::once())->method('insert');
        $connection->expects(self::once())->method('commit');
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturn('afd_ai_attachment_quota');
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(true);
        $lock->expects(self::once())->method('unlock');
        $sut = new AttachmentQuotaReconciler(
            $filesystem,
            $resource,
            $lock,
            $this->createMock(LoggerInterface::class)
        );

        $result = $sut->execute();
        self::assertTrue($result['reconciled']);
        self::assertSame(0, $result['global_bytes']);
        self::assertSame(1, $result['corrected']);
    }

    public function testCrashDuringCounterUpdateRollsBackAndUnlocks(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('isExist')->willReturn(false);
        $directory->method('search')->willReturn([]);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->willReturn($directory);
        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('forUpdate')->willReturnSelf();
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('fetchAll')->willReturn([
            ['scope_id' => 7, 'scope_key' => '123', 'used_bytes' => 88, 'reserved_bytes' => 21]
        ]);
        $connection->method('fetchRow')->willReturn([
            'scope_id' => 9, 'used_bytes' => 88, 'reserved_bytes' => 21
        ]);
        $connection->expects(self::once())->method('beginTransaction');
        $connection->expects(self::once())->method('update')->willThrowException(
            new \RuntimeException('simulated database crash')
        );
        $connection->expects(self::once())->method('rollBack');
        $connection->expects(self::never())->method('commit');
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturn('afd_ai_attachment_quota');
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(true);
        $lock->expects(self::once())->method('unlock');
        $sut = new AttachmentQuotaReconciler(
            $filesystem,
            $resource,
            $lock,
            $this->createMock(LoggerInterface::class)
        );

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('simulated database crash');
        $sut->execute();
    }
}
