<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\ExpiredDataCleaner;
use Afd\AI\Model\Order\GuestOrderAccessRepository;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class ExpiredDataCleanerTest extends TestCase
{
    public function testDeletesOnlyOldUnreferencedGeneratedImages(): void
    {
        $now = 2_000_000_000;
        $media = $this->createMock(WriteInterface::class);
        $media->method('isExist')->willReturn(true);
        $media->method('search')->willReturn([
            'afd-ai/generated/referenced.png',
            'afd-ai/generated/orphan.webp',
            'afd-ai/generated/readme.txt',
        ]);
        $media->method('stat')->willReturn(['mtime' => $now - 700_000]);
        $media->expects(self::once())
            ->method('delete')
            ->with('afd-ai/generated/orphan.webp')
            ->willReturn(true);

        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->willReturn($media);
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->expects(self::once())->method('deleteExpired')->willReturn(3);

        $select = $this->createMock(Select::class);
        $select->method('from')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('orWhere')->willReturnSelf();
        $select->method('limit')->willReturnSelf();
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('fetchOne')->willReturnOnConsecutiveCalls('1', false);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturn('afd_ai_message');

        $cleaner = new ExpiredDataCleaner(
            $filesystem,
            $repository,
            $resource,
            $this->createMock(LoggerInterface::class)
        );

        self::assertSame(
            ['guest_access_rows' => 3, 'generated_images' => 1],
            $cleaner->execute($now)
        );
    }
}
