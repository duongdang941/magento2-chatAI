<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\AttachmentUploadManagementInterface;
use Afd\AI\Api\Data\AttachmentUploadTicketInterface;
use Afd\AI\Api\Data\AttachmentUploadTicketInterfaceFactory;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Maintenance\AttachmentDiskGuard;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\UrlInterface;

class AttachmentUploadManagement implements AttachmentUploadManagementInterface
{
    private const TICKET_TTL_SECONDS = 300; // 5 minutes
    private const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

    public function __construct(
        private readonly AiConfig $config,
        private readonly CustomerSession $customerSession,
        private readonly GuestChatIdentity $guestChatIdentity,
        private readonly AttachmentDiskGuard $diskGuard,
        private readonly AttachmentUploadTicketInterfaceFactory $ticketFactory,
        private readonly UrlInterface $urlBuilder,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly EncryptorInterface $encryptor
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
        $attachmentId = 'att_' . bin2hex(random_bytes(16));
        $expiresAt = time() + self::TICKET_TTL_SECONDS;
        $nonce = bin2hex(random_bytes(8));

        $ticketPayload = [
            'aid' => $attachmentId,
            'owner' => hash('sha256', (string)$ownerId),
            'purpose' => $purpose,
            'max_bytes' => $maxBytes,
            'mime' => $normalizedMime,
            'exp' => $expiresAt,
            'nonce' => $nonce,
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
        $payload = $this->verifyTicket($ticket);
        if (!$payload || ($payload['aid'] ?? '') !== $attachmentId) {
            throw new LocalizedException(__('Invalid or expired attachment upload ticket.'));
        }

        $expectedOwner = hash('sha256', (string)$this->resolveOwnerId());
        if (($payload['owner'] ?? '') !== $expectedOwner) {
            throw new LocalizedException(__('Attachment owner verification failed.'));
        }

        return true;
    }

    private function resolveOwnerId(): string|int
    {
        $customerId = (int)$this->customerSession->getCustomerId();
        if ($customerId > 0) {
            return $customerId;
        }

        $guestIdentity = $this->guestChatIdentity->resolve();
        if ($guestIdentity !== null && $guestIdentity !== '') {
            return $guestIdentity;
        }

        return $this->customerSession->getSessionId() ?: 'guest_' . bin2hex(random_bytes(8));
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

    private function verifyTicket(string $token): ?array
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

    private function getSecret(): string
    {
        $configured = (string)$this->scopeConfig->getValue('afd_ai/websocket/secret');
        if ($configured !== '') {
            return $configured;
        }

        return (string)$this->encryptor->getHash('afd-ai-upload-default-secret');
    }
}
