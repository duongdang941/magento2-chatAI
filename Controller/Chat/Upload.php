<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\AttachmentUploadManagement;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Maintenance\AttachmentDiskGuard;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Filesystem;
use Psr\Log\LoggerInterface;

/**
 * Handles authenticated streaming upload of chat attachments.
 */
class Upload implements HttpPostActionInterface, CsrfAwareActionInterface
{
    private const MIME_TO_EXTENSION = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp'
    ];
    private const CHUNK_SIZE = 65536; // 64 KiB

    public function __construct(
        private readonly RequestInterface $request,
        private readonly ResultFactory $resultFactory,
        private readonly CustomerSession $customerSession,
        private readonly GuestChatIdentity $guestChatIdentity,
        private readonly AttachmentDiskGuard $diskGuard,
        private readonly AiConfig $config,
        private readonly Filesystem $filesystem,
        private readonly AttachmentUploadManagement $uploadManagement,
        private readonly LoggerInterface $logger,
        private readonly ?\Afd\AI\Model\Attachment\AttachmentRepository $attachmentRepository = null
    ) {
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        if (!$this->config->isEnabled()) {
            return $result->setHttpResponseCode(403)->setData([
                'success' => false,
                'error' => 'AI Assistant is currently disabled.'
            ]);
        }

        $limits = $this->config->getAttachmentConfig();
        $this->diskGuard->assertCapacity((int)($limits['min_free_bytes'] ?? 104857600));

        $ticket = $this->extractTicket();
        if ($ticket === '') {
            return $result->setHttpResponseCode(401)->setData([
                'success' => false,
                'error' => 'Missing or invalid upload ticket.'
            ]);
        }

        $ticketPayload = $this->uploadManagement->verifyTicketPayload($ticket);
        if ($ticketPayload === null) {
            return $result->setHttpResponseCode(401)->setData([
                'success' => false,
                'error' => 'Invalid or expired upload ticket.'
            ]);
        }

        $attachmentId = (string)($ticketPayload['aid'] ?? '');
        $requestedId = (string)($this->request->getParam('id') ?? '');
        if ($requestedId !== '' && $requestedId !== $attachmentId) {
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'Attachment ID does not match ticket.'
            ]);
        }

        $maxBytes = (int)($ticketPayload['max_bytes'] ?? ($limits['max_image_bytes'] ?? 4194304));
        $ownerPath = $this->resolveOwnerPath();
        $expectedOwner = hash('sha256', (string)$this->resolveOwnerId());
        if (($ticketPayload['owner'] ?? '') !== $expectedOwner) {
            return $result->setHttpResponseCode(403)->setData([
                'success' => false,
                'error' => 'Attachment owner verification failed.'
            ]);
        }

        $varDir = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $tempRelativeDir = 'afd_ai/chat/temp';
        $varDir->create($tempRelativeDir);

        $tempFilePath = $varDir->getAbsolutePath(
            $tempRelativeDir . '/' . $attachmentId . '.' . bin2hex(random_bytes(8)) . '.tmp'
        );
        $hashContext = hash_init('sha256');
        $totalBytes = 0;

        $inputStream = $this->getInputStream();
        if (!$inputStream) {
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'No upload data received.'
            ]);
        }

        $targetFile = fopen($tempFilePath, 'wb');
        if (!$targetFile) {
            return $result->setHttpResponseCode(500)->setData([
                'success' => false,
                'error' => 'Unable to open target file for writing.'
            ]);
        }

        try {
            while (!feof($inputStream)) {
                $chunk = fread($inputStream, self::CHUNK_SIZE);
                if ($chunk === false) {
                    fclose($targetFile);
                    @unlink($tempFilePath);
                    return $result->setHttpResponseCode(400)->setData([
                        'success' => false,
                        'error' => 'Failed reading upload stream.'
                    ]);
                }
                if ($chunk === '') {
                    break;
                }
                $chunkLength = strlen($chunk);
                $totalBytes += $chunkLength;

                if ($totalBytes > $maxBytes) {
                    fclose($targetFile);
                    @unlink($tempFilePath);
                    return $result->setHttpResponseCode(413)->setData([
                        'success' => false,
                        'error' => 'Image exceeds maximum allowed size.'
                    ]);
                }

                hash_update($hashContext, $chunk);
                $written = fwrite($targetFile, $chunk);
                if ($written !== $chunkLength) {
                    fclose($targetFile);
                    @unlink($tempFilePath);
                    return $result->setHttpResponseCode(507)->setData([
                        'success' => false,
                        'error' => 'Storage write failure.'
                    ]);
                }
            }
            fclose($targetFile);
        } catch (\Throwable $e) {
            fclose($targetFile);
            @unlink($tempFilePath);
            $this->logger->error('Attachment stream upload error: ' . $e->getMessage());
            return $result->setHttpResponseCode(500)->setData([
                'success' => false,
                'error' => 'Upload stream failed.'
            ]);
        } finally {
            if (is_resource($inputStream)) {
                fclose($inputStream);
            }
        }

        if ($totalBytes === 0) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'Uploaded file is empty.'
            ]);
        }

        // Validate image magic bytes, MIME, and dimensions
        set_error_handler(static fn (): bool => true);
        try {
            $imageInfo = getimagesize($tempFilePath);
        } finally {
            restore_error_handler();
        }

        if (!is_array($imageInfo)) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'The uploaded file is not a valid image.'
            ]);
        }

        $detectedMime = strtolower((string)($imageInfo['mime'] ?? ''));
        if (!isset(self::MIME_TO_EXTENSION[$detectedMime])) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'Only JPG, PNG, or WebP images are supported.'
            ]);
        }

        $expectedMime = strtolower((string)($ticketPayload['mime'] ?? ''));
        if ($expectedMime !== '' && $detectedMime !== $expectedMime) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'Uploaded file MIME type does not match ticket declaration.'
            ]);
        }

        $width = (int)($imageInfo[0] ?? 0);
        $height = (int)($imageInfo[1] ?? 0);
        $pixels = $width * $height;
        $maxPixels = (int)($limits['max_total_pixels'] ?? 30000000);
        if ($width < 1 || $height < 1 || $pixels > $maxPixels) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(400)->setData([
                'success' => false,
                'error' => 'Image dimensions are too large.'
            ]);
        }

        $sha256 = hash_final($hashContext);
        $ext = self::MIME_TO_EXTENSION[$detectedMime];

        if ($this->attachmentRepository && !$this->attachmentRepository->claimForUpload(
            $attachmentId,
            $expectedOwner,
            (string)($ticketPayload['nonce'] ?? '')
        )) {
            @unlink($tempFilePath);
            return $result->setHttpResponseCode(409)->setData([
                'success' => false,
                'error' => 'Upload ticket has already been used or is no longer valid.'
            ]);
        }

        $ownerTargetDir = 'afd_ai/chat/' . $ownerPath . '/staged';
        $varDir->create($ownerTargetDir);
        $finalRelativePath = $ownerTargetDir . '/' . $attachmentId . '.' . $ext;
        $finalAbsolutePath = $varDir->getAbsolutePath($finalRelativePath);

        // Atomic rename from temp to staged path
        if (!rename($tempFilePath, $finalAbsolutePath)) {
            @unlink($tempFilePath);
            if ($this->attachmentRepository !== null) {
                $this->attachmentRepository->releaseUploadClaim($attachmentId);
            }
            return $result->setHttpResponseCode(500)->setData([
                'success' => false,
                'error' => 'Failed to stage uploaded attachment.'
            ]);
        }

        if ($this->attachmentRepository && !$this->attachmentRepository->recordStaged(
            $attachmentId,
            $finalRelativePath,
            $totalBytes,
            $sha256
        )) {
            @unlink($finalAbsolutePath);
            if ($this->attachmentRepository !== null) {
                $this->attachmentRepository->releaseUploadClaim($attachmentId);
            }
            return $result->setHttpResponseCode(409)->setData([
                'success' => false,
                'error' => 'Attachment upload state could not be committed.'
            ]);
        }

        return $result->setData([
            'success' => true,
            'attachment_id' => $attachmentId,
            'mime_type' => $detectedMime,
            'bytes' => $totalBytes,
            'sha256' => $sha256,
            'width' => $width,
            'height' => $height
        ]);
    }

    private function getInputStream()
    {
        if (isset($_FILES['file']['tmp_name']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
            return fopen($_FILES['file']['tmp_name'], 'rb');
        }
        return fopen('php://input', 'rb');
    }

    private function extractTicket(): string
    {
        $authHeader = (string)($this->request->getHeader('Authorization') ?? '');
        if (str_starts_with($authHeader, 'Bearer ')) {
            return trim(substr($authHeader, 7));
        }

        return trim((string)($this->request->getParam('ticket') ?? ''));
    }

    private function resolveOwnerId(): string|int
    {
        $customerId = (int)$this->customerSession->getCustomerId();
        if ($customerId > 0) {
            return $customerId;
        }

        $guestIdentity = (string)($this->guestChatIdentity->resolve() ?? '');
        if ($guestIdentity !== '' && preg_match('/^[a-f0-9]{32,64}$/i', $guestIdentity)) {
            return $guestIdentity;
        }

        return hash('sha256', (string)($this->customerSession->getSessionId() ?: 'guest'));
    }

    private function resolveOwnerPath(): string
    {
        $customerId = (int)$this->customerSession->getCustomerId();
        if ($customerId > 0) {
            return (string)$customerId;
        }

        $guestIdentity = (string)($this->guestChatIdentity->resolve() ?? '');
        if ($guestIdentity !== '' && preg_match('/^[a-f0-9]{32,64}$/i', $guestIdentity)) {
            return 'guest/' . $guestIdentity;
        }

        $sessionId = (string)($this->customerSession->getSessionId() ?? '');
        $safeSession = hash('sha256', $sessionId ?: 'guest');
        return 'guest/' . $safeSession;
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        // Upload is authenticated and protected via single-use HMAC token in header/body
        return true;
    }
}
