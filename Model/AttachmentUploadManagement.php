<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\AttachmentUploadManagementInterface;
use Afd\AI\Api\Data\AttachmentUploadTicketInterface;
use Afd\AI\Api\Data\AttachmentUploadTicketInterfaceFactory;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Maintenance\AttachmentDiskGuard;
use Afd\AI\Model\Maintenance\AttachmentQuotaCounter;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\UrlInterface;

class AttachmentUploadManagement implements AttachmentUploadManagementInterface
{
    private const TICKET_TTL_SECONDS = 300; // 5 minutes
    private const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    private const ALLOWED_PURPOSES = ['vision', 'support_attachment', 'message_attachment'];

    public function __construct(
        private readonly AiConfig $config,
        private readonly CustomerSession $customerSession,
        private readonly GuestChatIdentity $guestChatIdentity,
        private readonly AttachmentDiskGuard $diskGuard,
        private readonly AttachmentQuotaCounter $quotaCounter,
        private readonly AttachmentUploadTicketInterfaceFactory $ticketFactory,
        private readonly UrlInterface $urlBuilder,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly EncryptorInterface $encryptor,
        private readonly Filesystem $filesystem,
        private readonly ?\Magento\Framework\App\DeploymentConfig $deploymentConfig = null,
        private readonly ?\Afd\AI\Model\Attachment\AttachmentRepository $attachmentRepository = null
    ) {
    }

    /**
     * @inheritdoc
     */
    public function initiate(
        string $purpose = 'vision',
        int $declaredBytes = 0,
        string $declaredMimeType = 'image/jpeg'
    ): AttachmentUploadTicketInterface {
        if (!$this->config->isEnabled()) {
            throw new LocalizedException(__('AI Assistant is currently disabled.'));
        }

        if (!in_array($purpose, self::ALLOWED_PURPOSES, true)) {
            throw new LocalizedException(__('Invalid attachment upload purpose.'));
        }

        $limits = $this->config->getAttachmentConfig();
        $this->diskGuard->assertCapacity((int)($limits['min_free_bytes'] ?? 104857600));

        $normalizedMime = strtolower(trim($declaredMimeType));
        if (!in_array($normalizedMime, self::ALLOWED_MIME_TYPES, true)) {
            throw new LocalizedException(__('Only JPG, PNG, or WebP images are supported.'));
        }

        $maxBytes = (int)($limits['max_image_bytes'] ?? 4194304);
        if ($declaredBytes > $maxBytes) {
            throw new LocalizedException(__('Image exceeds maximum allowed size of %1 bytes.', $maxBytes));
        }

        $ownerId = $this->resolveOwnerId();
        $ownerPath = $this->resolveOwnerPath();
        $reserveBytes = $declaredBytes > 0 ? $declaredBytes : $maxBytes;

        // Reserve quota for upload session
        $this->quotaCounter->reserve(
            $ownerPath,
            (int)($limits['max_owner_storage_bytes'] ?? 67108864),
            $reserveBytes,
            (int)($limits['max_total_storage_bytes'] ?? 1073741824)
        );

        $attachmentId = 'att_' . bin2hex(random_bytes(16));
        $expiresAt = time() + self::TICKET_TTL_SECONDS;
        $nonce = bin2hex(random_bytes(8));
        $reservationId = 'res_' . bin2hex(random_bytes(16));

        if ($this->attachmentRepository) {
            $this->attachmentRepository->recordIssued(
                $attachmentId,
                (int)$this->customerSession->getCustomerId() > 0 ? 'customer' : 'guest',
                (string)$ownerId,
                $reserveBytes,
                $normalizedMime,
                $expiresAt,
                $reservationId,
                hash('sha256', $nonce)
            );
            $this->attachmentRepository->recordReservation(
                $reservationId,
                $attachmentId,
                $ownerPath,
                $reserveBytes,
                $expiresAt
            );
        }

        $ticketPayload = [
            'aid' => $attachmentId,
            'owner' => hash('sha256', (string)$ownerId),
            'purpose' => $purpose,
            'max_bytes' => $maxBytes,
            'reserved_bytes' => $reserveBytes,
            'mime' => $normalizedMime,
            'exp' => $expiresAt,
            'nonce' => $nonce,
            'res_id' => $reservationId
        ];

        $signedTicket = $this->signTicket($ticketPayload);
        $uploadUrl = $this->urlBuilder->getUrl('afd_ai/chat/upload', [
            '_secure' => true,
            'id' => $attachmentId
        ]);

        /** @var AttachmentUploadTicketInterface $ticket */
        $ticket = $this->ticketFactory->create();
        $ticket->setAttachmentId($attachmentId);
        $ticket->setUploadUrl($uploadUrl);
        $ticket->setTicket($signedTicket);
        $ticket->setMaxBytes($maxBytes);
        $ticket->setExpiresAt($expiresAt);
        $ticket->setAllowedMimeTypes(self::ALLOWED_MIME_TYPES);

        return $ticket;
    }

    /**
     * @inheritdoc
     */
    public function complete(string $attachmentId, string $ticket): bool
    {
        $payload = $this->verifyTicketPayload($ticket);
        if (!$payload || ($payload['aid'] ?? '') !== $attachmentId) {
            throw new LocalizedException(__('Invalid or expired attachment upload ticket.'));
        }

        $ownerId = $this->resolveOwnerId();
        $expectedOwner = hash('sha256', (string)$ownerId);
        if (($payload['owner'] ?? '') !== $expectedOwner) {
            throw new LocalizedException(__('Attachment owner verification failed.'));
        }

        $ownerPath = $this->resolveOwnerPath();
        $varDir = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
        $stagedDir = 'afd_ai/chat/' . $ownerPath . '/staged';
        $metaPath = $stagedDir . '/' . $attachmentId . '.meta.json';

        // Check if already committed (idempotency check via filesystem or repository)
        if ($this->attachmentRepository) {
            $canFinalize = $this->attachmentRepository->tryMarkFinalizing($attachmentId);
            if (!$canFinalize) {
                $existingRecord = $this->attachmentRepository->getAttachment($attachmentId);
                if ($existingRecord && in_array($existingRecord['state'] ?? '', ['committed', 'finalizing'], true)) {
                    return true;
                }
            }
        } elseif ($varDir->isFile($metaPath)) {
            $existingMeta = json_decode((string)$varDir->readFile($metaPath), true);
            if (is_array($existingMeta) && ($existingMeta['state'] ?? '') === 'committed') {
                return true;
            }
        }

        // Check if file exists in staged or final folder
        $foundFile = null;
        $fileExt = 'jpg';
        $fileSize = 0;
        $finalDir = 'afd_ai/chat/' . $ownerPath . '/final';
        $varDir->create($finalDir);

        foreach (['jpg', 'png', 'webp'] as $ext) {
            $finalPath = $finalDir . '/' . $attachmentId . '.' . $ext;
            if ($varDir->isFile($finalPath)) {
                $foundFile = $finalPath;
                $fileExt = $ext;
                $fileSize = (int)$varDir->stat($finalPath)['size'];
                break;
            }
            $stagedPath = $stagedDir . '/' . $attachmentId . '.' . $ext;
            if ($varDir->isFile($stagedPath)) {
                $foundFile = $stagedPath;
                $fileExt = $ext;
                $fileSize = (int)$varDir->stat($stagedPath)['size'];
                // Move from staged to final path atomically
                $finalAbs = $varDir->getAbsolutePath($finalPath);
                $stagedAbs = $varDir->getAbsolutePath($stagedPath);
                if (@rename($stagedAbs, $finalAbs)) {
                    $foundFile = $finalPath;
                }
                break;
            }
        }

        if (!$foundFile) {
            throw new LocalizedException(__('Uploaded attachment file not found.'));
        }

        $limits = $this->config->getAttachmentConfig();
        $reservedBytes = (int)($payload['reserved_bytes'] ?? $fileSize);

        // Commit quota with safety check
        if ($fileSize > $reservedBytes) {
            $additionalBytes = $fileSize - $reservedBytes;
            $this->quotaCounter->reserve(
                $ownerPath,
                (int)($limits['max_owner_storage_bytes'] ?? 67108864),
                $additionalBytes,
                (int)($limits['max_total_storage_bytes'] ?? 1073741824)
            );
            $this->quotaCounter->commit($ownerPath, $fileSize);
        } elseif ($fileSize < $reservedBytes) {
            $excessBytes = $reservedBytes - $fileSize;
            $this->quotaCounter->releaseReservation($ownerPath, $excessBytes);
            $this->quotaCounter->commit($ownerPath, $fileSize);
        } else {
            $this->quotaCounter->commit($ownerPath, $fileSize);
        }

        if ($this->attachmentRepository) {
            $this->attachmentRepository->recordCommitted($attachmentId, $foundFile);
            if (isset($payload['res_id'])) {
                $this->attachmentRepository->releaseReservation((string)$payload['res_id']);
            }
        }

        // Persist attachment meta state as committed
        $metaData = [
            'attachment_id' => $attachmentId,
            'owner' => $expectedOwner,
            'state' => 'committed',
            'file' => $foundFile,
            'bytes' => $fileSize,
            'committed_at' => time()
        ];
        $varDir->writeFile($metaPath, (string)json_encode($metaData, JSON_THROW_ON_ERROR));

        return true;
    }

    public function verifyTicketPayload(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 2) {
            return null;
        }

        [$payloadB64, $sigB64] = $parts;
        $secret = $this->getSecret();
        $expectedSig = hash_hmac('sha256', $payloadB64, $secret, true);
        $actualSig = base64_decode(strtr($sigB64, '-_', '+/'), true);

        if (!is_string($actualSig) || !hash_equals($expectedSig, $actualSig)) {
            return null;
        }

        $json = base64_decode(strtr($payloadB64, '-_', '+/'), true);
        if (!is_string($json)) {
            return null;
        }

        try {
            $data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }

        if (!is_array($data) || (int)($data['exp'] ?? 0) < time()) {
            return null;
        }

        return $data;
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

    private function signTicket(array $data): string
    {
        $json = (string)json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $b64 = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
        $secret = $this->getSecret();
        $signature = hash_hmac('sha256', $b64, $secret, true);
        $sigB64 = rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');

        return $b64 . '.' . $sigB64;
    }

    private function getSecret(): string
    {
        $configured = (string)$this->scopeConfig->getValue('afd_ai/websocket/secret');
        if ($configured !== '') {
            return $configured;
        }

        if ($this->deploymentConfig) {
            $cryptKey = (string)$this->deploymentConfig->get(\Magento\Framework\Config\ConfigOptionsListConstants::CONFIG_PATH_CRYPT_KEY);
            if ($cryptKey !== '') {
                return hash('sha256', 'afd_ai_upload:' . $cryptKey);
            }
        }

        return (string)$this->encryptor->getHash('afd-ai-upload-default-secret');
    }
}
