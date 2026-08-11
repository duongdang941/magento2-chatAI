<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Quality\FeedbackService;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Psr\Log\LoggerInterface;

class Feedback implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly CustomerSession $customerSession,
        private readonly FeedbackService $feedbackService,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        // Magento treats same-origin XMLHttpRequest POST actions as valid CSRF
        // requests. Requiring a second custom form-key header here caused a
        // valid Hyva session to be redirected to the storefront with an HTML
        // "Invalid Form Key" response before this controller could run.
        return $request instanceof HttpRequest && $request->isXmlHttpRequest();
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        try {
            $payload = json_decode($this->request->getContent(), true, 16, JSON_THROW_ON_ERROR);
            $customerId = (int)$this->customerSession->getCustomerId();
            $guestId = $customerId > 0 ? null : hash('sha256', (string)$this->customerSession->getSessionId());

            $conversationId = (int)($payload['conversation_id'] ?? 0);
            $messageId = (int)($payload['message_id'] ?? 0);
            $rating = strtolower(trim((string)($payload['rating'] ?? '')));
            $data = $rating === ''
                ? $this->feedbackService->clear(
                    $conversationId,
                    $messageId,
                    $customerId > 0 ? $customerId : null,
                    $guestId
                )
                : $this->feedbackService->save(
                    $conversationId,
                    $messageId,
                    $customerId > 0 ? $customerId : null,
                    $guestId,
                    $rating,
                    (string)($payload['reason'] ?? ''),
                    (string)($payload['comment'] ?? '')
                );
            return $result->setHttpResponseCode($data['status'] === 'success' ? 200 : 422)->setData($data);
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI feedback could not be saved.', ['exception' => $exception]);
            return $result->setHttpResponseCode(400)->setData([
                'status' => 'error',
                'message' => __('The rating could not be saved.')->render(),
            ]);
        }
    }
}
