<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

/**
 * Interface representing a short-lived, authenticated attachment upload ticket.
 */
interface AttachmentUploadTicketInterface
{
    public const ATTACHMENT_ID = 'attachment_id';
    public const UPLOAD_URL = 'upload_url';
    public const TICKET = 'ticket';
    public const MAX_BYTES = 'max_bytes';
    public const EXPIRES_AT = 'expires_at';
    public const ALLOWED_MIME_TYPES = 'allowed_mime_types';

    /**
     * @return string
     */
    public function getAttachmentId(): string;

    /**
     * @param string $attachmentId
     * @return $this
     */
    public function setAttachmentId(string $attachmentId);

    /**
     * @return string
     */
    public function getUploadUrl(): string;

    /**
     * @param string $uploadUrl
     * @return $this
     */
    public function setUploadUrl(string $uploadUrl);

    /**
     * @return string
     */
    public function getTicket(): string;

    /**
     * @param string $ticket
     * @return $this
     */
    public function setTicket(string $ticket);

    /**
     * @return int
     */
    public function getMaxBytes(): int;

    /**
     * @param int $maxBytes
     * @return $this
     */
    public function setMaxBytes(int $maxBytes);

    /**
     * @return int
     */
    public function getExpiresAt(): int;

    /**
     * @param int $expiresAt
     * @return $this
     */
    public function setExpiresAt(int $expiresAt);

    /**
     * @return string[]
     */
    public function getAllowedMimeTypes(): array;

    /**
     * @param string[] $allowedMimeTypes
     * @return $this
     */
    public function setAllowedMimeTypes(array $allowedMimeTypes);
}
