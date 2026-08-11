<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\UrlInterface;

/**
 * Stores chat image bytes outside the public web root and returns compact metadata for a message row.
 */
class ChatAttachmentStorage
{
    private const BASE_PATH = 'afd_ai/chat';
    private const MAX_BYTES = 4194304;
    private const MAX_ATTACHMENTS = 4;
    private const MIME_TO_EXTENSION = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp'
    ];

    public function __construct(
        private readonly Filesystem $filesystem,
        private readonly UrlInterface $urlBuilder
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

        $attachments = $decoded['attachments'] ?? null;
        if (!is_array($attachments)) {
            // Preserve compatibility with messages saved by the first attachment release.
            return $this->storeFromPayload($decoded, $ownerId, $conversationId);
        }

        if ($attachments === [] || count($attachments) > self::MAX_ATTACHMENTS) {
            throw new LocalizedException(__(
                'A message can contain from 1 to %1 images.',
                self::MAX_ATTACHMENTS
            ));
        }

        $items = [];
        foreach ($attachments as $attachment) {
            if (!is_array($attachment)) {
                throw new LocalizedException(__('Invalid image upload payload.'));
            }
            $items[] = $this->storeMetadataFromPayload($attachment, $ownerId, $conversationId);
        }

        return (string)json_encode(
            ['version' => 1, 'items' => $items],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
    }

    /**
     * Supports the legacy JSONL migration without ever writing base64 to the database.
     *
     * @param array<string, mixed> $payload
     * @throws LocalizedException
     */
    public function storeFromPayload(array $payload, int|string $ownerId, int $conversationId): string
    {
        return (string)json_encode(
            $this->storeMetadataFromPayload($payload, $ownerId, $conversationId),
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{name:string,mime_type:string,size:int,url:string,storage:string}
     * @throws LocalizedException
     */
    private function storeMetadataFromPayload(array $payload, int|string $ownerId, int $conversationId): array
    {
        $ownerPath = $this->ownerPath($ownerId);
        if ($ownerPath === null || $conversationId < 1) {
            throw new LocalizedException(__('Invalid chat attachment owner.'));
        }

        $declaredMimeType = strtolower(trim((string)($payload['mime_type'] ?? $payload['mimeType'] ?? '')));
        $encodedData = preg_replace('/\s+/', '', (string)($payload['data'] ?? $payload['base64'] ?? '')) ?? '';
        if (!isset(self::MIME_TO_EXTENSION[$declaredMimeType]) || $encodedData === '') {
            throw new LocalizedException(__('Only JPG, PNG, or WebP images are supported.'));
        }

        // Reject oversized payloads before allocating decoded image bytes.
        $maximumEncodedLength = (int)ceil(self::MAX_BYTES * 4 / 3) + 8;
        if (strlen($encodedData) > $maximumEncodedLength || !preg_match('/^[A-Za-z0-9+\/=]+$/D', $encodedData)) {
            throw new LocalizedException(__('Invalid image upload payload.'));
        }

        $binary = base64_decode($encodedData, true);
        if ($binary === false || $binary === '' || strlen($binary) > self::MAX_BYTES) {
            throw new LocalizedException(__('Image must be 4MB or smaller.'));
        }

        set_error_handler(static fn (): bool => true);
        try {
            $imageInfo = getimagesizefromstring($binary);
        } finally {
            restore_error_handler();
        }
        $detectedMimeType = is_array($imageInfo) ? strtolower((string)($imageInfo['mime'] ?? '')) : '';
        if ($detectedMimeType === '' || $detectedMimeType !== $declaredMimeType || !isset(self::MIME_TO_EXTENSION[$detectedMimeType])) {
            throw new LocalizedException(__('The uploaded file is not a valid image.'));
        }

        try {
            $randomName = bin2hex(random_bytes(20));
        } catch (\Throwable $exception) {
            throw new LocalizedException(__('Could not prepare the image upload.'));
        }

        $relativeDirectory = self::BASE_PATH . '/' . $ownerPath . '/' . $conversationId;
        $relativeFile = $relativeDirectory . '/' . $randomName . '.' . self::MIME_TO_EXTENSION[$detectedMimeType];
        $privateDirectory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $privateDirectory->create($relativeDirectory);
        $privateDirectory->writeFile($relativeFile, $binary);

        return [
            'name' => $this->sanitizeName((string)($payload['name'] ?? 'uploaded-image')),
            'mime_type' => $detectedMimeType,
            'size' => strlen($binary),
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
