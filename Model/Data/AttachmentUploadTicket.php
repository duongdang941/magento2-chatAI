<?php
declare(strict_types=1);

namespace Afd\AI\Model\Data;

use Afd\AI\Api\Data\AttachmentUploadTicketInterface;
use Magento\Framework\DataObject;

class AttachmentUploadTicket extends DataObject implements AttachmentUploadTicketInterface
{
    public function getAttachmentId(): string
    {
        return (string)$this->getData(self::ATTACHMENT_ID);
    }

    public function setAttachmentId(string $attachmentId)
    {
        return $this->setData(self::ATTACHMENT_ID, $attachmentId);
    }

    public function getUploadUrl(): string
    {
        return (string)$this->getData(self::UPLOAD_URL);
    }

    public function setUploadUrl(string $uploadUrl)
    {
        return $this->setData(self::UPLOAD_URL, $uploadUrl);
    }

    public function getTicket(): string
    {
        return (string)$this->getData(self::TICKET);
    }

    public function setTicket(string $ticket)
    {
        return $this->setData(self::TICKET, $ticket);
    }

    public function getMaxBytes(): int
    {
        return (int)$this->getData(self::MAX_BYTES);
    }

    public function setMaxBytes(int $maxBytes)
    {
        return $this->setData(self::MAX_BYTES, $maxBytes);
    }

    public function getExpiresAt(): int
    {
        return (int)$this->getData(self::EXPIRES_AT);
    }

    public function setExpiresAt(int $expiresAt)
    {
        return $this->setData(self::EXPIRES_AT, $expiresAt);
    }

    public function getAllowedMimeTypes(): array
    {
        return (array)($this->getData(self::ALLOWED_MIME_TYPES) ?? []);
    }

    public function setAllowedMimeTypes(array $allowedMimeTypes)
    {
        return $this->setData(self::ALLOWED_MIME_TYPES, $allowedMimeTypes);
    }
}
