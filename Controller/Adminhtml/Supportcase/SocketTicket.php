<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Security\WebSocketTicketIssuer;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Backend\Model\Auth\Session as AuthSession;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class SocketTicket extends Action implements HttpGetActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';

    public function __construct(
        Context $context,
        private readonly AuthSession $authSession,
        private readonly WebSocketTicketIssuer $ticketIssuer,
        private readonly AiConfig $aiConfig
    ) {
        parent::__construct($context);
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $admin = $this->authSession->getUser();
            if (!$admin || !(int)$admin->getId()) {
                throw new \RuntimeException('The administrator session is unavailable.');
            }

            return $result->setData([
                'status' => 'success',
                'websocket_url' => $this->aiConfig->getChatServerUrl(),
                'websocket_ticket' => $this->ticketIssuer->issueAdmin(
                    (int)$admin->getId(),
                    trim((string)$admin->getFirstName() . ' ' . (string)$admin->getLastName()),
                    (string)$this->authSession->getSessionId()
                ),
            ]);
        } catch (\Throwable $exception) {
            return $result->setHttpResponseCode(503)->setData([
                'status' => 'error',
                'message' => (string)__('Live support connection is unavailable.'),
            ]);
        }
    }
}
