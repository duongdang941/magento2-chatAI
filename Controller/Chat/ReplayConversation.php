<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\ChatMessagePayload;
use Afd\AI\Model\Conversation\ConversationStoreScope;
use Magento\Checkout\Model\Session as CheckoutSession;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Psr\Log\LoggerInterface;

class ReplayConversation implements HttpGetActionInterface
{
    private HttpRequest $request;
    private ResultFactory $resultFactory;
    private ConversationRepositoryInterface $conversationRepository;
    private MessageRepositoryInterface $messageRepository;
    private SearchCriteriaBuilder $searchCriteriaBuilder;
    private SortOrderBuilder $sortOrderBuilder;
    private CheckoutSession $checkoutSession;
    private CustomerSession $customerSession;
    private ChatMessagePayload $chatMessagePayload;
    private ConversationStoreScope $conversationStoreScope;
    private LoggerInterface $logger;

    public function __construct(
        HttpRequest $request,
        ResultFactory $resultFactory,
        ConversationRepositoryInterface $conversationRepository,
        MessageRepositoryInterface $messageRepository,
        SearchCriteriaBuilder $searchCriteriaBuilder,
        SortOrderBuilder $sortOrderBuilder,
        CheckoutSession $checkoutSession,
        CustomerSession $customerSession,
        ChatMessagePayload $chatMessagePayload,
        ConversationStoreScope $conversationStoreScope,
        LoggerInterface $logger
    ) {
        $this->request = $request;
        $this->resultFactory = $resultFactory;
        $this->conversationRepository = $conversationRepository;
        $this->messageRepository = $messageRepository;
        $this->searchCriteriaBuilder = $searchCriteriaBuilder;
        $this->sortOrderBuilder = $sortOrderBuilder;
        $this->checkoutSession = $checkoutSession;
        $this->customerSession = $customerSession;
        $this->chatMessagePayload = $chatMessagePayload;
        $this->conversationStoreScope = $conversationStoreScope;
        $this->logger = $logger;
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $conversationId = (int)$this->request->getParam('conversation_id');
            $sessionId = trim((string)$this->request->getParam('session_id'));
            $customerId = (int)$this->customerSession->getCustomerId();

            $sortOrder = $this->sortOrderBuilder
                ->setField('created_at')
                ->setDirection('ASC')
                ->create();

            if ($conversationId > 0) {
                if (!$customerId) {
                    return $resultJson->setData([
                        'status' => 'error',
                        'message' => 'Login required',
                        'messages' => []
                    ]);
                }

                $conversation = $this->conversationRepository->getById($conversationId);
                if ((int)$conversation->getCustomerId() !== $customerId
                    || !$this->conversationStoreScope->matches($conversation)) {
                    return $resultJson->setData([
                        'status' => 'error',
                        'message' => 'Unauthorized',
                        'messages' => []
                    ]);
                }

                $searchCriteria = $this->searchCriteriaBuilder
                    ->addFilter('conversation_id', $conversationId)
                    ->addSortOrder($sortOrder)
                    ->create();

                $response = $this->buildReplayResponse($searchCriteria);
                $response['conversation'] = [
                    'id' => $conversationId,
                    'title' => $conversation->getTitle(),
                    'customer_id' => (int)$conversation->getCustomerId(),
                    'created_at' => $conversation->getCreatedAt(),
                    'updated_at' => $conversation->getUpdatedAt()
                ];

                return $resultJson->setData($response + [
                    'status' => 'success',
                    'conversationId' => $conversationId
                ]);
            }

            if ($sessionId === '') {
                if (!$this->checkoutSession->isSessionExists()) {
                    $this->checkoutSession->start();
                }
                $sessionId = (string)$this->checkoutSession->getSessionId();
            }

            if ($sessionId === '') {
                return $resultJson->setData([
                    'status' => 'success',
                    'messages' => [],
                    'sessionId' => ''
                ]);
            }

            $searchCriteria = $this->searchCriteriaBuilder
                ->addFilter('session_id', $sessionId)
                ->addSortOrder($sortOrder)
                ->create();

            $response = $this->buildReplayResponse($searchCriteria);
            $response['sessionId'] = $sessionId;

            return $resultJson->setData($response + ['status' => 'success']);
        } catch (\Exception $e) {
            $this->logger->error('REPLAY CONVERSATION ERROR: ' . $e->getMessage());
            return $resultJson->setData([
                'status' => 'error',
                'message' => 'Could not load replay data',
                'messages' => []
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function buildReplayResponse($searchCriteria): array
    {
        $list = $this->messageRepository->getList($searchCriteria);
        $messages = [];

        foreach ($list->getItems() as $item) {
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
                'created_at' => $item->getCreatedAt()
            ];
        }

        return [
            'messages' => $messages,
            'messageCount' => count($messages)
        ];
    }
}
