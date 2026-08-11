<?php
declare(strict_types=1);

namespace Afd\AI\Block;

use Magento\Framework\View\Element\Template;
use Magento\Framework\View\Element\Template\Context;
use Magento\Customer\Model\Session as CustomerSession;

class ChatWidget extends Template
{
    private CustomerSession $customerSession;

    public function __construct(
        Context $context,
        CustomerSession $customerSession,
        array $data = []
    ) {
        parent::__construct($context, $data);
        $this->customerSession = $customerSession;
    }

    /**
     * Check if module is enabled
     */
    public function isEnabled(): bool
    {
        return $this->_scopeConfig->isSetFlag('afd_ai/general/enabled');
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
        return $this->_scopeConfig->getValue('afd_ai/general/chat_server_url') ?: 'ws://127.0.0.1:3001';
    }

    /**
     * Get current customer ID
     */
    public function getCustomerId(): ?int
    {
        return $this->customerSession->isLoggedIn() ? (int)$this->customerSession->getCustomerId() : null;
    }

    /**
     * Deprecated: do not mint or expose OAuth customer tokens from template rendering.
     */
    public function getCustomerToken(): ?string
    {
        return null;
    }
}
