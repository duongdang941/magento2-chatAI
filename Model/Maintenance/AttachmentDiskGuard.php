<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\Lock\LockManagerInterface;

/**
 * Rejects new attachment writes when the var volume is below its safety
 * watermark. The check intentionally uses the volume containing Magento's
 * private var directory, not a deployment-specific absolute path.
 */
class AttachmentDiskGuard
{
    private const ATTACHMENT_PATH = 'afd_ai/chat';
    private const WRITE_LOCK = 'afd_ai_attachment_write';
    private const WRITE_LOCK_TIMEOUT_SECONDS = 5;

    public function __construct(
        private readonly Filesystem $filesystem,
        private readonly LockManagerInterface $lockManager
    )
    {
    }

    /**
     * @throws LocalizedException when free space cannot be measured or is too low
     */
    public function assertCapacity(int $minimumFreeBytes, int $additionalBytes = 0): void
    {
        $this->assertCapacityUnlocked($minimumFreeBytes, $additionalBytes);
    }

    /**
     * Atomically reserve module-owned disk capacity and write while the shared
     * Magento lock is held. This closes the check-then-write race between
     * concurrent PHP workers (and between hosts when the lock backend is DB or
     * shared cache based).
     *
     * @template T
     * @param callable():T $write
     * @return T
     * @throws LocalizedException
     */
    public function reserveAndWrite(
        string $ownerPath,
        int $minimumFreeBytes,
        int $maximumOwnerBytes,
        int $additionalBytes,
        callable $write
    ): mixed {
        if (!$this->lockManager->lock(self::WRITE_LOCK, self::WRITE_LOCK_TIMEOUT_SECONDS)) {
            throw new LocalizedException(__('Image uploads are busy. Please try again shortly.'));
        }

        try {
            $this->assertCapacityUnlocked($minimumFreeBytes, $additionalBytes);
            $this->assertOwnerQuota($ownerPath, $maximumOwnerBytes, $additionalBytes);
            return $write();
        } finally {
            $this->lockManager->unlock(self::WRITE_LOCK);
        }
    }

    private function assertCapacityUnlocked(int $minimumFreeBytes, int $additionalBytes): void
    {
        $minimumFreeBytes = max(0, $minimumFreeBytes);
        $additionalBytes = max(0, $additionalBytes);
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $path = $directory->getAbsolutePath(self::ATTACHMENT_PATH);
        $freeBytes = @disk_free_space($path);
        if ($freeBytes === false) {
            $freeBytes = @disk_free_space($directory->getAbsolutePath());
        }

        if ($freeBytes === false || $freeBytes < ($minimumFreeBytes + $additionalBytes)) {
            throw new LocalizedException(__('Image uploads are temporarily unavailable because storage is low.'));
        }
    }

    private function assertOwnerQuota(string $ownerPath, int $maximumOwnerBytes, int $additionalBytes): void
    {
        $maximumOwnerBytes = max(0, $maximumOwnerBytes);
        $additionalBytes = max(0, $additionalBytes);
        if ($maximumOwnerBytes < $additionalBytes) {
            throw new LocalizedException(__('This shopper has reached the chat attachment storage limit.'));
        }

        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $relativeOwnerPath = self::ATTACHMENT_PATH . '/' . trim($ownerPath, '/');
        if (!$directory->isExist($relativeOwnerPath)) {
            return;
        }

        $maximumExistingBytes = $maximumOwnerBytes - $additionalBytes;
        $usedBytes = 0;
        foreach ($directory->search('*/*', $relativeOwnerPath) as $relativePath) {
            if (!preg_match('/\/\d+\/[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $relativePath)) {
                continue;
            }
            $stat = $directory->stat($relativePath);
            $usedBytes += max(0, (int)($stat['size'] ?? 0));
            if ($usedBytes > $maximumExistingBytes) {
                throw new LocalizedException(__('This shopper has reached the chat attachment storage limit.'));
            }
        }
    }

    /** @return int|false */
    public function freeBytes(): int|false
    {
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $path = $directory->getAbsolutePath(self::ATTACHMENT_PATH);
        $freeBytes = @disk_free_space($path);
        return $freeBytes === false ? @disk_free_space($directory->getAbsolutePath()) : $freeBytes;
    }
}
