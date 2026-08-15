<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Api\Data\AttachmentUploadTicketInterface;

/**
 * Service contract for initiating and managing authenticated chat attachment uploads.
 */
interface AttachmentUploadManagementInterface
{
    /**
     * Initiates an attachment upload session and returns a single-use upload ticket.
     *
     * @param string $purpose
     * @param int $declaredBytes
     * @param string $declaredMimeType
     * @return \Afd\AI\Api\Data\AttachmentUploadTicketInterface
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function initiate(
        string $purpose = 'vision',
        int $declaredBytes = 0,
        string $declaredMimeType = 'image/jpeg'
    ): AttachmentUploadTicketInterface;

    /**
     * Completes and verifies an uploaded attachment by ID.
     *
     * @param string $attachmentId
     * @param string $ticket
     * @return bool
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function complete(string $attachmentId, string $ticket): bool;
}
