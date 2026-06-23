<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Mail\Template\TransportBuilder;
use Magento\Store\Model\ScopeInterface;
use Psr\Log\LoggerInterface;

/** Sends a verification code and rejects Magento's silent no-send modes. */
class GuestOrderOtpSender
{
    private const XML_PATH_EMAIL_DISABLED = 'system/smtp/disable';
    private const XML_PATH_MAGEPLAZA_ENABLED = 'smtp/general/enabled';
    private const XML_PATH_MAGEPLAZA_DEVELOPER_MODE = 'smtp/developer/developer_mode';

    public function __construct(
        private readonly TransportBuilder $transportBuilder,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly LoggerInterface $logger
    ) {
    }

    public function isAvailable(): bool
    {
        if ($this->scopeConfig->isSetFlag(self::XML_PATH_EMAIL_DISABLED, ScopeInterface::SCOPE_STORE)) {
            return false;
        }

        return !$this->scopeConfig->isSetFlag(self::XML_PATH_MAGEPLAZA_ENABLED, ScopeInterface::SCOPE_STORE)
            || !$this->scopeConfig->isSetFlag(self::XML_PATH_MAGEPLAZA_DEVELOPER_MODE, ScopeInterface::SCOPE_STORE);
    }

    public function send(string $email, string $code): bool
    {
        if (!$this->isAvailable()) {
            $this->logger->warning('Afd AI verification email was not sent because email delivery is disabled.');
            return false;
        }

        try {
            $this->transportBuilder
                ->setTemplateIdentifier('afd_ai_guest_order_otp')
                ->setTemplateOptions(['area' => 'frontend', 'store' => 0])
                ->setTemplateVars(['code' => $code])
                ->setFromByScope('general')
                ->addTo($email)
                ->getTransport()
                ->sendMessage();
            return true;
        } catch (\Throwable $exception) {
            $this->logger->error('Afd AI verification email could not be sent.', [
                'exception' => $exception,
                'recipient_hash' => hash('sha256', strtolower(trim($email))),
            ]);
            return false;
        }
    }
}
