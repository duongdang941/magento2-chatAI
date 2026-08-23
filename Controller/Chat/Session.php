<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Model\Security\WebSocketTicketIssuer;
use Psr\Log\LoggerInterface;

class Session implements HttpGetActionInterface
{
    public function __construct(
        private readonly ResultFactory $resultFactory,
        private readonly CustomerSession $customerSession,
        private readonly LoggerInterface $logger,
        private readonly WebSocketTicketIssuer $ticketIssuer
    ) {
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $isLoggedIn = $this->customerSession->isLoggedIn();
            $customerId = $isLoggedIn ? (int)$this->customerSession->getCustomerId() : null;
            $sessionId = (string)$this->customerSession->getSessionId();

            return $resultJson->setData([
                'status' => 'success',
                'isLoggedIn' => $isLoggedIn,
                'customerId' => $customerId,
                'customerName' => null,
                'websocketTicket' => $this->ticketIssuer->issue($customerId, $sessionId),
            ]);
        } catch (\Exception $e) {
            $this->logger->error('CHAT SESSION ERROR', ['exception' => $e]);
            return $resultJson->setData([
                'status' => 'error',
                'isLoggedIn' => false,
                'customerId' => null,
                'customerName' => null
            ]);
        }
    }
}
