<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\Lock\LockManagerInterface;

/** Serializes attachment writes and enforces free-space plus owner quota. */
class AttachmentDiskGuard
{
    private const ATTACHMENT_PATH = 'afd_ai/chat';
    private const WRITE_LOCK = 'afd_ai_attachment_write';
    private const WRITE_LOCK_TIMEOUT_SECONDS = 5;

    public function __construct(
        private readonly Filesystem $filesystem,
        private readonly LockManagerInterface $lockManager,
        private readonly ?AttachmentQuotaCounter $quotaCounter = null
    ) {
    }

    public function assertCapacity(int $minimumFreeBytes, int $additionalBytes = 0): void
    {
        $this->assertCapacityUnlocked($minimumFreeBytes, $additionalBytes);
    }

    /**
     * @template T
     * @param callable():T $write
     * @return T
     */
    public function reserveAndWrite(
        string $ownerPath,
        int $minimumFreeBytes,
        int $maximumOwnerBytes,
        int $additionalBytes,
        callable $write,
        ?int $maximumGlobalBytes = null
    ): mixed {
        if (!$this->lockManager->lock(self::WRITE_LOCK, self::WRITE_LOCK_TIMEOUT_SECONDS)) {
            throw new LocalizedException(__('Image uploads are busy. Please try again shortly.'));
        }

        $reserved = false;
        try {
            $this->assertCapacityUnlocked($minimumFreeBytes, $additionalBytes);
            if ($this->quotaCounter !== null) {
                if (!$this->quotaCounter->isInitialized($ownerPath)) {
                    $this->quotaCounter->initializeOwner($ownerPath, $this->scanOwnerBytes($ownerPath));
                }
                if ($maximumGlobalBytes !== null && !$this->quotaCounter->isGlobalInitialized()) {
                    $this->quotaCounter->initializeGlobal($this->scanAllBytes());
                }
                $this->quotaCounter->reserve($ownerPath, $maximumOwnerBytes, $additionalBytes, $maximumGlobalBytes);
                $reserved = true;
            } else {
                $this->assertOwnerQuotaByScan($ownerPath, $maximumOwnerBytes, $additionalBytes);
            }
            try {
                $result = $write();
                if ($reserved) {
                    $this->quotaCounter?->commit($ownerPath, $additionalBytes);
                }
                return $result;
            } catch (\Throwable $exception) {
                if ($reserved) {
                    $this->quotaCounter?->releaseReservation($ownerPath, $additionalBytes);
                }
                throw $exception;
            }
        } finally {
            $this->lockManager->unlock(self::WRITE_LOCK);
        }
    }

    private function assertCapacityUnlocked(int $minimumFreeBytes, int $additionalBytes): void
    {
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $path = $directory->getAbsolutePath(self::ATTACHMENT_PATH);
        $freeBytes = $this->diskFreeBytes($path);
        if ($freeBytes === false) {
            $freeBytes = $this->diskFreeBytes($directory->getAbsolutePath());
        }
        if ($freeBytes === false || $freeBytes < max(0, $minimumFreeBytes) + max(0, $additionalBytes)) {
            throw new LocalizedException(__('Image uploads are temporarily unavailable because storage is low.'));
        }
    }

    private function assertOwnerQuotaByScan(string $ownerPath, int $maximumOwnerBytes, int $additionalBytes): void
    {
        if ($maximumOwnerBytes < $additionalBytes || $this->scanOwnerBytes($ownerPath) + max(0, $additionalBytes) > max(0, $maximumOwnerBytes)) {
            throw new LocalizedException(__('This shopper has reached the chat attachment storage limit.'));
        }
    }

    private function scanOwnerBytes(string $ownerPath): int
    {
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $relativeOwnerPath = self::ATTACHMENT_PATH . '/' . trim($ownerPath, '/');
        if (!$directory->isExist($relativeOwnerPath)) {
            return 0;
        }
        $usedBytes = 0;
        foreach ($directory->search('*/*', $relativeOwnerPath) as $relativePath) {
            if (!preg_match('/\/\d+\/[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $relativePath)) {
                continue;
            }
            $stat = $directory->stat($relativePath);
            $usedBytes += max(0, (int)($stat['size'] ?? 0));
        }
        return $usedBytes;
    }

    private function scanAllBytes(): int
    {
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $usedBytes = 0;
        foreach ($directory->search('*', self::ATTACHMENT_PATH) as $relativePath) {
            if (!preg_match('#^' . preg_quote(self::ATTACHMENT_PATH, '#') . '/(?:\d+|guest/[a-f0-9]{64})/\d+/[a-f0-9]{40}\.(?:jpg|png|webp)$#D', $relativePath)) continue;
            $stat = $directory->stat($relativePath);
            $usedBytes += max(0, (int)($stat['size'] ?? 0));
        }
        return $usedBytes;
    }

    public function releaseUsedBytes(string $ownerPath, int $bytes): void
    {
        $this->quotaCounter?->releaseUsed($ownerPath, $bytes);
    }

    /** @return int|false */
    public function freeBytes(): int|false
    {
        $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $path = $directory->getAbsolutePath(self::ATTACHMENT_PATH);
        $freeBytes = $this->diskFreeBytes($path);
        return $freeBytes === false ? $this->diskFreeBytes($directory->getAbsolutePath()) : $freeBytes;
    }

    /** @return int|false */
    private function diskFreeBytes(string $path): int|false
    {
        set_error_handler(static fn (): bool => true);
        try {
            $freeBytes = disk_free_space($path);
        } finally {
            restore_error_handler();
        }

        return $freeBytes === false ? false : max(0, (int)$freeBytes);
    }
}
