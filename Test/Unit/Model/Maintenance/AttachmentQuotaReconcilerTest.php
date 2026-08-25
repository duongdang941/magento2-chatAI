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

    /**
     * A stale finalizing attachment with an aged-out reservation must get a
     * grace extension BEFORE any force-expiry pass, so the verified-complete
     * final file can still be committed atomically instead of wedging forever.
     */
    public function testGrantsGraceWindowBeforeCommittingStaleFinalizingAttachment(): void
    {
        $finalPath = 'afd_ai/chat/guest/abc123/9/finalhash.webp';
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('search')->willReturn([]);
        $directory->method('isFile')->with($finalPath)->willReturn(true);
        $directory->method('stat')->with($finalPath)->willReturn(['size' => 4096]);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->with(DirectoryList::VAR_DIR)->willReturn($directory);

        $select = $this->getMockBuilder(Select::class)->disableOriginalConstructor()->getMock();
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('forUpdate')->willReturnSelf();

        $updates = [];
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('isTableExists')->willReturn(true);
        $connection->method('fetchAll')->willReturnOnConsecutiveCalls(
            [],
            [[
                'attachment_id' => 'att789',
                'reservation_id' => 'res456',
                'owner_key' => 'abc123',
                'owner_type' => 'guest',
                'conversation_id' => 9,
                'final_path' => $finalPath,
                'staged_path' => '',
            ]],
            []
        );
        // Existing global row already matches the scanned usage, so the only
        // correction in this run is the recovered finalization commit itself.
        $connection->method('fetchRow')->willReturn([
            'scope_id' => 5,
            'used_bytes' => 0,
            'reserved_bytes' => 0,
        ]);
        $connection->method('update')->willReturnCallback(
            static function (string $table, array $data, array $where = []) use (&$updates): int {
                $updates[] = ['table' => $table, 'data' => $data];
                return 1;
            }
        );
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnArgument(0);
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(true);

        $updatesAtCommit = null;
        $repository = $this->createMock(\Afd\AI\Model\Attachment\AttachmentRepository::class);
        $repository->expects(self::once())->method('commitFinalAttachmentAtomic')->with(
            'att789',
            $finalPath,
            'guest/abc123',
            4096,
            'res456',
            9,
            'abc123'
        )->willReturnCallback(static function () use (&$updates, &$updatesAtCommit): void {
            $updatesAtCommit = $updates;
        });

        $sut = new AttachmentQuotaReconciler(
            $filesystem,
            $resource,
            $lock,
            $this->createMock(LoggerInterface::class),
            $repository
        );

        $result = $sut->execute();

        self::assertTrue($result['reconciled']);
        self::assertSame(1, $result['corrected']);
        self::assertNotNull($updatesAtCommit);
        // The reservation received its active grace extension before commit.
        $graceExtensions = array_filter(
            $updatesAtCommit,
            static fn (array $update): bool =>
                $update['table'] === 'afd_ai_attachment_reservation'
                && (($update['data']['state'] ?? '') === 'active')
        );
        self::assertCount(1, $graceExtensions);
    }
}
