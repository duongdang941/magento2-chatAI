<?php
declare(strict_types=1);
namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Support\SupportTakeoverService;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class SupportState implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $authorizer,
        private readonly SupportTakeoverService $takeoverService
    ) {}
    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException { return null; }
    public function validateForCsrf(RequestInterface $request): ?bool { return $request instanceof HttpRequest; }
    public function execute(): Json
    {
        /** @var Json $result */ $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        try {
            $this->authorizer->assertAuthorized();
            $payload = json_decode($this->request->getContent(), true, 8, JSON_THROW_ON_ERROR);
            $customerId = max(0, (int)($payload['customerId'] ?? 0));
            return $result->setData($this->takeoverService->getConversationState(
                (int)($payload['conversationId'] ?? 0),
                $customerId > 0 ? $customerId : null,
                $customerId > 0 ? null : (string)($payload['guestId'] ?? '')
            ));
        } catch (\Throwable) {
            return $result->setHttpResponseCode(403)->setData(['active' => false, 'agent_label' => '', 'case_id' => 0]);
        }
    }
}
