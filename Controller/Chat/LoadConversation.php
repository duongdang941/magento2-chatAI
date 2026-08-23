<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\Conversation\ConversationStoreScope;
use Afd\AI\Model\Conversation\MessagePageLoader;
use Magento\Customer\Model\Session as CustomerSession;
use Psr\Log\LoggerInterface;

class LoadConversation implements HttpGetActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly ConversationRepositoryInterface $conversationRepository,
        private readonly CustomerSession $customerSession,
        private readonly MessagePageLoader $messagePageLoader,
        private readonly ConversationStoreScope $conversationStoreScope,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $conversationId = (int)$this->request->getParam('id');
            $customerId = $this->customerSession->getCustomerId();

            if (!$conversationId || !$customerId) {
                return $resultJson->setData(['status' => 'error', 'messages' => []]);
            }

            // Verify the conversation belongs to this customer
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== (int)$customerId
                || !$this->conversationStoreScope->matches($conversation)) {
                return $resultJson->setData(['status' => 'error', 'messages' => []]);
            }

            $beforeMessageId = (int)$this->request->getParam('before_message_id');
            $page = $this->messagePageLoader->load(
                $conversationId,
                (int)$customerId,
                $beforeMessageId > 0 ? $beforeMessageId : null,
                (int)$this->request->getParam('page_size', 50)
            );

            if ($page === null) {
                return $resultJson->setData(['status' => 'error', 'messages' => []]);
            }

            return $resultJson->setData([
                'status' => 'success',
                'messages' => $page['messages'],
                'has_more' => $page['has_more'],
                'next_before_message_id' => $page['next_before_message_id'],
                'conversationId' => $conversationId,
                'title' => $conversation->getTitle()
            ]);
        } catch (\Exception $e) {
            $this->logger->error('LOAD CONVERSATION ERROR', ['exception' => $e]);
            return $resultJson->setData(['status' => 'error', 'messages' => []]);
        }
    }
}
