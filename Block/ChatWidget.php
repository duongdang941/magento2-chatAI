<?php
declare(strict_types=1);

namespace Afd\AI\Block;

use Magento\Framework\View\Element\Template;
use Magento\Framework\View\Element\Template\Context;
use Magento\Customer\Model\Session as CustomerSession;
use Afd\AI\Model\Config\Config as AiConfig;

class ChatWidget extends Template
{
    private CustomerSession $customerSession;
    private AiConfig $aiConfig;

    public function __construct(
        Context $context,
        CustomerSession $customerSession,
        AiConfig $aiConfig,
        array $data = []
    ) {
        parent::__construct($context, $data);
        $this->customerSession = $customerSession;
        $this->aiConfig = $aiConfig;
    }

    /**
     * Check if module is enabled
     */
    public function isEnabled(): bool
    {
        return $this->aiConfig->isEnabled();
    }

    /**
     * Check if customer is logged in
     */
    public function isLoggedIn(): bool
    {
        return $this->customerSession->isLoggedIn();
    }

    /**
     * Get chat server URL (for WebSocket, if needed)
     */
    public function getChatServerUrl(): string
    {
        return trim((string)$this->aiConfig->getChatServerUrl());
    }

    /**
     * Get current customer ID
     */
    public function getCustomerId(): ?int
    {
        return $this->customerSession->isLoggedIn() ? (int)$this->customerSession->getCustomerId() : null;
    }

    /** Expose only the feature flag; provider credentials remain server-side. */
    public function isVoiceInputEnabled(): bool
    {
        return (bool)$this->aiConfig->getVoiceConfig()['enabled'];
    }

    public function getVoiceMaximumDuration(): int
    {
        return (int)$this->aiConfig->getVoiceConfig()['max_duration_seconds'];
    }

    /**
     * The browser receives only an enable flag. OpenAI credentials and model
     * selection are kept in Magento configuration and pushed to Node only.
     */
    public function isLiveVoiceEnabled(): bool
    {
        $voice = $this->aiConfig->getVoiceConfig();
        return (bool)($voice['live']['enabled'] ?? false);
    }

    public function getLiveVoiceMaximumDuration(): int
    {
        $voice = $this->aiConfig->getVoiceConfig();
        return (int)($voice['live']['max_duration_seconds'] ?? 600);
    }

    /** Browser-side preflight limits; no provider or service credential is exposed. */
    public function getAttachmentLimits(): array
    {
        $config = $this->aiConfig->getAttachmentConfig();
        return [
            'maxImageBytes' => (int)$config['max_image_bytes'],
            'maxImages' => (int)$config['max_images_per_message'],
            'maxTotalImageBytes' => (int)$config['max_total_image_bytes'],
            'maxTotalEncodedBytes' => (int)$config['max_total_encoded_bytes'],
            'maxTotalPixels' => (int)$config['max_total_pixels'],
            // Keep the browser preflight aligned with the gateway default.
            // Deployments that override MAX_WS_PAYLOAD_BYTES should also
            // override this value in their storefront integration.
            'maxWebSocketPayloadBytes' => 8 * 1024 * 1024,
        ];
    }

    /**
     * Deprecated: do not mint or expose OAuth customer tokens from template rendering.
     */
    public function getCustomerToken(): ?string
    {
        return null;
    }
}
