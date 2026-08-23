<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\ChatMessagePayload;
use Afd\AI\Model\Conversation\MessagePageLoader;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Checkout\Model\Session as CheckoutSession;
use Magento\Customer\Model\Session as CustomerSession;
use Psr\Log\LoggerInterface;

class History implements HttpGetActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly MessageRepositoryInterface $messageRepository,
        private readonly SearchCriteriaBuilder $searchCriteriaBuilder,
        private readonly SortOrderBuilder $sortOrderBuilder,
        private readonly CheckoutSession $checkoutSession,
        private readonly CustomerSession $customerSession,
        private readonly ChatMessagePayload $chatMessagePayload,
        private readonly MessagePageLoader $messagePageLoader,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            // Support loading by conversation_id (preferred) or session_id (fallback)
            $conversationId = $this->request->getParam('conversation_id');

            if ($conversationId) {
                $customerId = (int)$this->customerSession->getCustomerId();
                if (!$customerId) {
                    return $resultJson->setData(['status' => 'error', 'messages' => []]);
                }

                $beforeMessageId = (int)$this->request->getParam('before_message_id');
                $page = $this->messagePageLoader->load(
                    (int)$conversationId,
                    $customerId,
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
                    'conversationId' => (int)$conversationId
                ]);
            } else {
                // Fallback: load by session_id (backward compatible)
                if (!$this->checkoutSession->isSessionExists()) {
                    $this->checkoutSession->start();
                }
                $sessionId = $this->checkoutSession->getSessionId();
                
                if (!$sessionId) {
                    return $resultJson->setData(['status' => 'success', 'messages' => []]);
                }

                $sortOrder = $this->sortOrderBuilder
                    ->setField('created_at')
                    ->setDirection('ASC')
                    ->create();
                $searchCriteria = $this->searchCriteriaBuilder
                    ->addFilter('session_id', $sessionId)
                    ->addSortOrder($sortOrder)
                    ->setPageSize(50)
                    ->create();
            }

            $list = $this->messageRepository->getList($searchCriteria);
            $messages = [];

            foreach ($list->getItems() as $item) {
                /** @var \Afd\AI\Api\Data\MessageInterface $item */
                $decodedMessage = $this->chatMessagePayload->decodeStoredMessage(
                    $item->getRole(),
                    (string)$item->getContent(),
                    (string)$item->getEntityId()
                );
                $messages[] = [
                    'role' => $item->getRole() === 'user' ? 'user' : 'assistant',
                    'content' => $decodedMessage['content'],
                    'parts' => $decodedMessage['parts'],
                    'interrupted' => $decodedMessage['interrupted'],
                    'stopped_after_seconds' => $decodedMessage['stopped_after_seconds'],
                    'source' => $decodedMessage['source'] ?? '',
                    'sender_label' => $decodedMessage['sender_label'] ?? '',
                    'attachment' => $item->getAttachment(),
                    'created_at' => $item->getCreatedAt()
                ];
            }

            $response = [
                'status' => 'success',
                'messages' => $messages
            ];

            $response['sessionId'] = $sessionId ?? '';

            return $resultJson->setData($response);
        } catch (\Exception $e) {
            $this->logger->error('HISTORY ERROR', ['exception' => $e]);
            return $resultJson->setData(['status' => 'error', 'messages' => []]);
        }
    }
}
