<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Api\ConversationRepositoryInterface;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Customer\Model\Session as CustomerSession;
use Psr\Log\LoggerInterface;

class Conversations implements HttpGetActionInterface
{
    private const PAGE_SIZE = 20;

    private $resultFactory;
    private $conversationRepository;
    private $searchCriteriaBuilder;
    private $sortOrderBuilder;
    private $customerSession;
    private $logger;
    private $request;

    public function __construct(
        ResultFactory $resultFactory,
        ConversationRepositoryInterface $conversationRepository,
        SearchCriteriaBuilder $searchCriteriaBuilder,
        SortOrderBuilder $sortOrderBuilder,
        CustomerSession $customerSession,
        LoggerInterface $logger,
        RequestInterface $request
    ) {
        $this->resultFactory = $resultFactory;
        $this->conversationRepository = $conversationRepository;
        $this->searchCriteriaBuilder = $searchCriteriaBuilder;
        $this->sortOrderBuilder = $sortOrderBuilder;
        $this->customerSession = $customerSession;
        $this->logger = $logger;
        $this->request = $request;
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $customerId = $this->customerSession->getCustomerId();

            if (!$customerId) {
                return $resultJson->setData([
                    'status' => 'success',
                    'conversations' => [],
                    'has_more' => false,
                    'next_page' => null,
                    'page' => 1,
                    'isLoggedIn' => false
                ]);
            }

            $page = max(1, (int)$this->request->getParam('page', 1));

            $sortOrder = $this->sortOrderBuilder
                ->setField('updated_at')
                ->setDirection('DESC')
                ->create();

            $searchCriteria = $this->searchCriteriaBuilder
                ->addFilter('customer_id', $customerId)
                ->addSortOrder($sortOrder)
                ->setPageSize(self::PAGE_SIZE)
                ->setCurrentPage($page)
                ->create();

            $list = $this->conversationRepository->getList($searchCriteria);
            $conversations = [];

            foreach ($list->getItems() as $item) {
                $conversations[] = [
                    'id' => (int)$item->getConversationId(),
                    'title' => $item->getTitle(),
                    'created_at' => $item->getCreatedAt(),
                    'updated_at' => $item->getUpdatedAt()
                ];
            }

            return $resultJson->setData([
                'status' => 'success',
                'conversations' => $conversations,
                'has_more' => ($page * self::PAGE_SIZE) < (int)$list->getTotalCount(),
                'next_page' => ($page * self::PAGE_SIZE) < (int)$list->getTotalCount() ? $page + 1 : null,
                'page' => $page,
                'isLoggedIn' => true
            ]);
        } catch (\Exception $e) {
            $this->logger->error('CONVERSATIONS ERROR: ' . $e->getMessage());
            return $resultJson->setData([
                'status' => 'error',
                'conversations' => [],
                'has_more' => false,
                'next_page' => null,
                'page' => 1,
                'isLoggedIn' => false
            ]);
        }
    }
}
