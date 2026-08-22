<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\ExpiredDataCleaner;
use Afd\AI\Model\Maintenance\ChatAttachmentCleaner;
use Afd\AI\Model\Maintenance\GeneratedImageReferenceRepository;
use Afd\AI\Model\Order\GuestOrderAccessRepository;
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

        $imageReferences = $this->createMock(GeneratedImageReferenceRepository::class);
        $imageReferences->expects(self::exactly(2))
            ->method('isReferenced')
            ->willReturnMap([
                ['referenced.png', true],
                ['orphan.webp', false],
            ]);

        $attachments = $this->createMock(ChatAttachmentCleaner::class);
        $attachments->expects(self::once())->method('execute')->with($now)->willReturn(0);

        $cleaner = new ExpiredDataCleaner(
            $filesystem,
            $repository,
            $imageReferences,
            $attachments,
            $this->createMock(LoggerInterface::class)
        );

        self::assertSame(
            ['guest_access_rows' => 3, 'generated_images' => 1, 'chat_attachments' => 0],
            $cleaner->execute($now)
        );
    }
}
