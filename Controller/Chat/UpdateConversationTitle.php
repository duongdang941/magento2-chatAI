<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\Conversation\ConversationStoreScope;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Data\Form\FormKey;
use Psr\Log\LoggerInterface;

class UpdateConversationTitle implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly ConversationRepositoryInterface $conversationRepository,
        private readonly ConversationStoreScope $conversationStoreScope,
        private readonly CustomerSession $customerSession,
        private readonly FormKey $formKey,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        $headerFormKey = (string)$request->getHeader('X-Form-Key');

        return $request->getHeader('X-Requested-With') === 'XMLHttpRequest'
            && $headerFormKey !== ''
            && hash_equals($this->formKey->getFormKey(), $headerFormKey);
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $input = json_decode($this->request->getContent(), true) ?? [];
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $title = trim((string)($input['title'] ?? ''));
            $customerId = (int)$this->customerSession->getCustomerId();

            if (!$conversationId || !$customerId || $title === '') {
                return $resultJson->setData([
                    'status' => 'error',
                    'message' => 'Invalid request'
                ]);
            }

            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== $customerId
                || !$this->conversationStoreScope->matches($conversation)) {
                return $resultJson->setData([
                    'status' => 'error',
                    'message' => 'Unauthorized or conversation not found'
                ]);
            }

            $title = mb_substr($title, 0, 255);
            $conversation->setTitle($title);
            $this->conversationRepository->save($conversation);

            return $resultJson->setData([
                'status' => 'success',
                'conversation_id' => $conversationId,
                'title' => $title
            ]);
        } catch (\Exception $e) {
            $this->logger->error('UPDATE CONVERSATION TITLE ERROR', ['exception' => $e]);
            return $resultJson->setData([
                'status' => 'error',
                'message' => 'Could not update conversation title'
            ]);
        }
    }
}
