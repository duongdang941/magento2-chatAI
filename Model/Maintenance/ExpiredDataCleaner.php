<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Afd\AI\Model\Order\GuestOrderAccessRepository;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Psr\Log\LoggerInterface;

/** Removes expired verification rows and unreferenced generated images. */
class ExpiredDataCleaner
{
    private const GENERATED_IMAGE_PATH = 'afd-ai/generated';
    private const OTP_GRACE_SECONDS = 86400;
    private const ORPHAN_IMAGE_RETENTION_SECONDS = 604800;
    private const MAX_IMAGES_PER_RUN = 500;

    private WriteInterface $mediaDirectory;

    public function __construct(
        Filesystem $filesystem,
        private readonly GuestOrderAccessRepository $guestOrderAccessRepository,
        private readonly GeneratedImageReferenceRepository $generatedImageReferenceRepository,
        private readonly LoggerInterface $logger
    ) {
        $this->mediaDirectory = $filesystem->getDirectoryWrite(DirectoryList::MEDIA);
    }

    /** @return array{guest_access_rows:int,generated_images:int} */
    public function execute(?int $now = null): array
    {
        $now ??= time();
        $deletedRows = $this->guestOrderAccessRepository->deleteExpired(
            gmdate('Y-m-d H:i:s', $now - self::OTP_GRACE_SECONDS)
        );

        return [
            'guest_access_rows' => $deletedRows,
            'generated_images' => $this->deleteUnreferencedGeneratedImages($now),
        ];
    }

    private function deleteUnreferencedGeneratedImages(int $now): int
    {
        if (!$this->mediaDirectory->isExist(self::GENERATED_IMAGE_PATH)) {
            return 0;
        }

        $deleted = 0;
        $checked = 0;
        foreach ($this->mediaDirectory->search('*', self::GENERATED_IMAGE_PATH) as $relativePath) {
            if ($checked >= self::MAX_IMAGES_PER_RUN) {
                break;
            }
            if (!$this->isGeneratedImage($relativePath)) {
                continue;
            }
            $checked++;
            $deleted += $this->deleteCandidate($relativePath, $now) ? 1 : 0;
        }

        return $deleted;
    }

    private function deleteCandidate(string $relativePath, int $now): bool
    {
        try {
            $stat = $this->mediaDirectory->stat($relativePath);
            $modifiedAt = (int)($stat['mtime'] ?? 0);
            if ($modifiedAt <= 0
                || $modifiedAt > $now - self::ORPHAN_IMAGE_RETENTION_SECONDS
                || $this->generatedImageReferenceRepository->isReferenced(basename($relativePath))
            ) {
                return false;
            }

            return $this->mediaDirectory->delete($relativePath);
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI generated-image cleanup skipped a file.', [
                'path' => $relativePath,
                'exception' => $exception,
            ]);
            return false;
        }
    }

    private function isGeneratedImage(string $relativePath): bool
    {
        return str_starts_with($relativePath, self::GENERATED_IMAGE_PATH . '/')
            && preg_match('/\.(?:png|jpe?g|webp)$/i', $relativePath) === 1;
    }

}
