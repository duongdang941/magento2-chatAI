<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\UrlInterface;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Maintenance\AttachmentDiskGuard;

/**
 * Stores chat image bytes outside the public web root and returns compact metadata for a message row.
 */
class ChatAttachmentStorage
{
    private const BASE_PATH = 'afd_ai/chat';
    private const MIME_TO_EXTENSION = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp'
    ];

    public function __construct(
        private readonly Filesystem $filesystem,
        private readonly UrlInterface $urlBuilder,
        private readonly AiConfig $config,
        private readonly AttachmentDiskGuard $diskGuard
    ) {
    }

    /**
     * @throws LocalizedException
     */
    public function storeFromJson(string $payload, int|string $ownerId, int $conversationId): string
    {
        try {
            $decoded = json_decode($payload, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new LocalizedException(__('Invalid image upload payload.'));
        }

        if (!is_array($decoded)) {
            throw new LocalizedException(__('Invalid image upload payload.'));
        }

        $limits = $this->config->getAttachmentConfig();
        // A cheap early rejection avoids base64 decoding and image inspection
        // when the var volume is already below the configured safety floor.
        // The authoritative capacity check is repeated under a shared lock
        // immediately before writing below.
        $this->diskGuard->assertCapacity((int)($limits['min_free_bytes'] ?? 104857600));
        $attachments = $decoded['attachments'] ?? null;
        if (!is_array($attachments)) {
            // Preserve compatibility with messages saved by the first attachment release.
            return $this->storeFromPayload($decoded, $ownerId, $conversationId, $limits);
        }

        $maximumAttachments = (int)$limits['max_images_per_message'];
        if ($attachments === [] || count($attachments) > $maximumAttachments) {
            throw new LocalizedException(__(
                'A message can contain from 1 to %1 images.',
                $maximumAttachments
            ));
        }

        $items = [];
        $validated = [];
        $totalBytes = 0;
        $totalPixels = 0;
        $totalEncodedBytes = 0;
        $maximumEncodedBytes = (int)$limits['max_total_encoded_bytes'];
        foreach ($attachments as $attachment) {
            if (!is_array($attachment)) {
                throw new LocalizedException(__('Invalid image upload payload.'));
            }
            // Reject the aggregate transport budget before base64_decode() and
            // image parsing allocate binary buffers for each item. This is a
            // defense-in-depth check for internal callers and rolling deploys
            // that may not have passed through the Node validator.
            $encodedData = preg_replace('/\s+/', '', (string)($attachment['data'] ?? $attachment['base64'] ?? '')) ?? '';
            $totalEncodedBytes += strlen($encodedData);
            if ($totalEncodedBytes > $maximumEncodedBytes) {
                throw new LocalizedException(__('The combined image upload is too large.'));
            }
            $item = $this->validatePayload($attachment);
            $totalBytes += $item['size'];
            $totalPixels += $item['pixels'];
            if ($totalBytes > (int)$limits['max_total_image_bytes']
                || $totalPixels > (int)$limits['max_total_pixels']) {
                throw new LocalizedException(__('The combined image upload is too large.'));
            }
            $validated[] = $item;
        }
        $ownerPath = $this->ownerPath($ownerId);
        if ($ownerPath === null || $conversationId < 1) {
            throw new LocalizedException(__('Invalid chat attachment owner.'));
        }

        return $this->diskGuard->reserveAndWrite(
            $ownerPath,
            (int)($limits['min_free_bytes'] ?? 104857600),
            (int)($limits['max_owner_storage_bytes'] ?? 67108864),
            $totalBytes,
            function () use (&$items, $validated, $ownerId, $conversationId): string {
                foreach ($validated as $item) {
                    $items[] = $this->storeValidatedPayload($item, $ownerId, $conversationId);
                }
                return (string)json_encode(
                    ['version' => 1, 'items' => $items],
                    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
                );
            }
        );
    }

    /**
     * Supports the legacy JSONL migration without ever writing base64 to the database.
     *
     * @param array<string, mixed> $payload
     * @throws LocalizedException
     */
    public function storeFromPayload(
        array $payload,
        int|string $ownerId,
        int $conversationId,
        ?array $limits = null
    ): string
    {
        $limits ??= $this->config->getAttachmentConfig();
        $this->diskGuard->assertCapacity((int)($limits['min_free_bytes'] ?? 104857600));
        $validated = $this->validatePayload($payload);
        $ownerPath = $this->ownerPath($ownerId);
        if ($ownerPath === null || $conversationId < 1) {
            throw new LocalizedException(__('Invalid chat attachment owner.'));
        }

        return $this->diskGuard->reserveAndWrite(
            $ownerPath,
            (int)($limits['min_free_bytes'] ?? 104857600),
            (int)($limits['max_owner_storage_bytes'] ?? 67108864),
            (int)$validated['size'],
            fn (): string => (string)json_encode(
                $this->storeValidatedPayload($validated, $ownerId, $conversationId),
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
            )
        );
    }

    /** @return array{name:string,mime_type:string,size:int,pixels:int,binary:string} */
    private function validatePayload(array $payload): array
    {
        $limits = $this->config->getAttachmentConfig();
        $maximumBytes = (int)$limits['max_image_bytes'];
        $declaredMimeType = strtolower(trim((string)($payload['mime_type'] ?? $payload['mimeType'] ?? '')));
        $encodedData = preg_replace('/\s+/', '', (string)($payload['data'] ?? $payload['base64'] ?? '')) ?? '';
        if (!isset(self::MIME_TO_EXTENSION[$declaredMimeType]) || $encodedData === '') {
            throw new LocalizedException(__('Only JPG, PNG, or WebP images are supported.'));
        }

        // Reject oversized payloads before allocating decoded image bytes.
        $maximumEncodedLength = (int)ceil($maximumBytes * 4 / 3) + 8;
        if (strlen($encodedData) > $maximumEncodedLength || !preg_match('/^[A-Za-z0-9+\/=]+$/D', $encodedData)) {
            throw new LocalizedException(__('Invalid image upload payload.'));
        }

        $binary = base64_decode($encodedData, true);
        if ($binary === false || $binary === '' || strlen($binary) > $maximumBytes) {
            throw new LocalizedException(__('Image must be 4MB or smaller.'));
        }

        set_error_handler(static fn (): bool => true);
        try {
            $imageInfo = getimagesizefromstring($binary);
        } finally {
            restore_error_handler();
        }
        $width = is_array($imageInfo) ? (int)($imageInfo[0] ?? 0) : 0;
        $height = is_array($imageInfo) ? (int)($imageInfo[1] ?? 0) : 0;
        $pixels = $width * $height;
        if ($width < 1 || $height < 1 || $pixels > (int)$limits['max_total_pixels']) {
            throw new LocalizedException(__('Image dimensions are too large.'));
        }
        $detectedMimeType = is_array($imageInfo) ? strtolower((string)($imageInfo['mime'] ?? '')) : '';
        if ($detectedMimeType === '' || $detectedMimeType !== $declaredMimeType || !isset(self::MIME_TO_EXTENSION[$detectedMimeType])) {
            throw new LocalizedException(__('The uploaded file is not a valid image.'));
        }

        return [
            'name' => $this->sanitizeName((string)($payload['name'] ?? 'uploaded-image')),
            'mime_type' => $detectedMimeType,
            'size' => strlen($binary),
            'pixels' => $pixels,
            'binary' => $binary,
        ];
    }

    /** @param array{name:string,mime_type:string,size:int,pixels:int,binary:string} $payload */
    private function storeValidatedPayload(array $payload, int|string $ownerId, int $conversationId): array
    {
        $ownerPath = $this->ownerPath($ownerId);
        if ($ownerPath === null || $conversationId < 1) {
            throw new LocalizedException(__('Invalid chat attachment owner.'));
        }

        try {
            $randomName = bin2hex(random_bytes(20));
        } catch (\Throwable $exception) {
            throw new LocalizedException(__('Could not prepare the image upload.'));
        }

        $relativeDirectory = self::BASE_PATH . '/' . $ownerPath . '/' . $conversationId;
        $relativeFile = $relativeDirectory . '/' . $randomName . '.' . self::MIME_TO_EXTENSION[$payload['mime_type']];
        $privateDirectory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $privateDirectory->create($relativeDirectory);
        $privateDirectory->writeFile($relativeFile, $payload['binary']);

        return [
            'name' => $payload['name'],
            'mime_type' => $payload['mime_type'],
            'size' => $payload['size'],
            'url' => $this->urlBuilder->getUrl('afd_ai/chat/attachment', [
                '_secure' => true,
                'conversation_id' => $conversationId,
                'file' => basename($relativeFile),
            ]),
            'storage' => 'private-v1',
        ];
    }

    public function deleteConversationAttachments(int|string $ownerId, int $conversationId): void
    {
        $ownerPath = $this->ownerPath($ownerId);
        if ($ownerPath === null || $conversationId < 1) {
            return;
        }

        $relativeDirectory = self::BASE_PATH . '/' . $ownerPath . '/' . $conversationId;
        foreach ([DirectoryList::VAR_DIR, DirectoryList::MEDIA] as $directoryCode) {
            try {
                // MEDIA is retained here only to clean files written by older releases.
                $this->filesystem->getDirectoryWrite($directoryCode)->delete($relativeDirectory);
            } catch (\Throwable $exception) {
                // Database deletion must not fail because a stale file cannot be removed.
            }
        }
    }

    private function ownerPath(int|string $ownerId): ?string
    {
        if (is_int($ownerId) || ctype_digit((string)$ownerId)) {
            return (int)$ownerId > 0 ? (string)(int)$ownerId : null;
        }

        $guestId = strtolower(trim((string)$ownerId));
        return preg_match('/^[a-f0-9]{64}$/', $guestId) ? 'guest/' . $guestId : null;
    }

    private function sanitizeName(string $name): string
    {
        $name = trim(basename(str_replace('\\', '/', $name)));
        $name = preg_replace('/[^\pL\pN._ -]+/u', '', $name) ?? '';
        $name = trim($name, '. ');

        return mb_substr($name !== '' ? $name : 'uploaded-image', 0, 120);
    }
}
