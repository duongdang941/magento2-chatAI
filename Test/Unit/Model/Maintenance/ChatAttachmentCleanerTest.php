<?php
declare(strict_types=1);
namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Maintenance\ChatAttachmentCleaner;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

final class ChatAttachmentCleanerTest extends TestCase
{
    public function testMissingAttachmentDirectoryIsASafeNoop(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->expects(self::once())->method('isExist')->with('afd_ai/chat')->willReturn(false);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->expects(self::once())->method('getDirectoryWrite')->with(DirectoryList::VAR_DIR)->willReturn($directory);
        $resource = $this->createMock(ResourceConnection::class);
        $config = $this->createMock(AiConfig::class);
        $logger = $this->createMock(LoggerInterface::class);
        $cleaner = new ChatAttachmentCleaner($filesystem, $resource, $config, $logger);
        self::assertSame(0, $cleaner->execute(1700000000));
    }
}
