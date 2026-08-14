<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\AttachmentDiskGuard;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Magento\Framework\Lock\LockManagerInterface;
use PHPUnit\Framework\TestCase;

class AttachmentDiskGuardTest extends TestCase
{
    public function testReservationSerializesCapacityCheckAndWrite(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('getAbsolutePath')->willReturnCallback(
            static fn (?string $path = null): string => '/tmp' . ($path ? '/' . $path : '')
        );
        $directory->method('isExist')->willReturn(false);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->willReturn($directory);

        $locks = $this->createMock(LockManagerInterface::class);
        $locks->expects(self::once())->method('lock')->with('afd_ai_attachment_write', 5)->willReturn(true);
        $locks->expects(self::once())->method('unlock')->with('afd_ai_attachment_write')->willReturn(true);

        $guard = new AttachmentDiskGuard($filesystem, $locks);
        self::assertSame(
            'written',
            $guard->reserveAndWrite('guest/' . str_repeat('a', 64), 1, 1024, 1, static fn (): string => 'written')
        );
    }

    public function testReservationAlwaysReleasesTheSharedLockWhenWriterFails(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('getAbsolutePath')->willReturn('/tmp');
        $directory->method('isExist')->willReturn(false);
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->willReturn($directory);

        $locks = $this->createMock(LockManagerInterface::class);
        $locks->expects(self::once())->method('lock')->willReturn(true);
        $locks->expects(self::once())->method('unlock')->willReturn(true);

        $guard = new AttachmentDiskGuard($filesystem, $locks);
        $this->expectException(\RuntimeException::class);
        $guard->reserveAndWrite('1', 1, 1024, 1, static function (): never {
            throw new \RuntimeException('writer failed');
        });
    }

    public function testRejectsAReservationLargerThanTheOwnerQuota(): void
    {
        $directory = $this->createMock(WriteInterface::class);
        $directory->method('getAbsolutePath')->willReturn('/tmp');
        $filesystem = $this->createMock(Filesystem::class);
        $filesystem->method('getDirectoryWrite')->willReturn($directory);

        $locks = $this->createMock(LockManagerInterface::class);
        $locks->expects(self::once())->method('lock')->willReturn(true);
        $locks->expects(self::once())->method('unlock')->willReturn(true);

        $guard = new AttachmentDiskGuard($filesystem, $locks);
        $this->expectException(\Magento\Framework\Exception\LocalizedException::class);
        $guard->reserveAndWrite('1', 1, 1, 2, static fn (): string => 'never');
    }
}
