<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Gateway\InternalRequestSigner;
use Afd\AI\Model\Gateway\GatewayTlsConfigurator;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\HTTP\Client\CurlFactory;
use Magento\Framework\Serialize\Serializer\Json;
use Psr\Log\LoggerInterface;

/** Closes customer WebSockets immediately when Magento logs the user out. */
class RevokeGatewaySessionOnLogout implements ObserverInterface
{
    public function __construct(
        private readonly AiConfig $config,
        private readonly CustomerSession $customerSession,
        private readonly CurlFactory $curlFactory,
        private readonly Json $json,
        private readonly LoggerInterface $logger,
        private readonly InternalRequestSigner $requestSigner,
        private readonly GatewayTlsConfigurator $gatewayTlsConfigurator
    ) {
    }

    public function execute(Observer $observer): void
    {
        $secret = $this->config->getNodeSyncSecret();
        $serverUrl = $this->toHttpUrl((string)$this->config->getChatServerUrl());
        $sessionId = (string)$this->customerSession->getSessionId();
        $customer = $observer->getEvent()->getCustomer();
        $customerId = is_object($customer) ? (int)$customer->getId() : 0;

        if (strlen($secret) < 32 || $serverUrl === '' || $sessionId === '') {
            return;
        }

        $payload = [
            'version' => 1,
            'event_id' => bin2hex(random_bytes(16)),
            'session_hash' => hash('sha256', $sessionId),
            'customer_id' => max(0, $customerId),
        ];
        $body = $this->json->serialize($payload);
        $timestamp = (string)time();

        try {
            $curl = $this->curlFactory->create();
            $this->gatewayTlsConfigurator->configure($curl, $serverUrl);
            $curl->setTimeout(3);
            $curl->addHeader('Accept', 'application/json');
            $curl->addHeader('Content-Type', 'application/json');
            $curl->addHeader('X-Afd-AI-Timestamp', $timestamp);
            $curl->addHeader(
                'X-Afd-AI-Signature',
                $this->requestSigner->signature($secret, $timestamp, 'POST', '/internal/session-revoke', $body)
            );
            $curl->post(rtrim($serverUrl, '/') . '/internal/session-revoke', $body);
        } catch (\Throwable $exception) {
            // Logout must never be blocked by a gateway outage. A socket also
            // expires its ticket server-side within one minute as a fallback.
            $this->logger->warning('Afd AI could not revoke a logged-out gateway session.', [
                'exception' => $exception,
            ]);
        }
    }

    private function toHttpUrl(string $url): string
    {
        $url = trim($url);
        if (str_starts_with($url, 'wss://')) {
            return 'https://' . substr($url, 6);
        }
        if (str_starts_with($url, 'ws://')) {
            return 'http://' . substr($url, 5);
        }

        return preg_match('#^https?://#', $url) ? $url : '';
    }
}
