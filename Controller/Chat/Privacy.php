<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Privacy\ChatDataService;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Data\Form\FormKey;

class Privacy implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly CustomerSession $customerSession,
        private readonly FormKey $formKey,
        private readonly ChatDataService $chatDataService
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException { return null; }
    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return $request->getHeader('X-Requested-With') === 'XMLHttpRequest'
            && hash_equals($this->formKey->getFormKey(), (string)$request->getHeader('X-Form-Key'));
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        $payload = json_decode($this->request->getContent(), true) ?: [];
        $customerId = (int)$this->customerSession->getCustomerId();
        $guestId = $customerId > 0 ? null : hash('sha256', (string)$this->customerSession->getSessionId());
        $action = (string)($payload['action'] ?? 'export');

        if ($action === 'delete') {
            if ((string)($payload['confirmation'] ?? '') !== 'DELETE') {
                return $result->setHttpResponseCode(422)->setData(['status' => 'requires_confirmation', 'message' => __('Type DELETE to confirm.')->render()]);
            }
            return $result->setData($this->chatDataService->delete($customerId ?: null, $guestId));
        }
        return $result->setData($this->chatDataService->export($customerId ?: null, $guestId));
    }
}
