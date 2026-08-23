<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\Conversation\ConversationStoreScope;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Customer\Model\Session as CustomerSession;
use Psr\Log\LoggerInterface;

class Conversations implements HttpGetActionInterface
{
    private const PAGE_SIZE = 20;

    public function __construct(
        private readonly ResultFactory $resultFactory,
        private readonly ConversationRepositoryInterface $conversationRepository,
        private readonly SearchCriteriaBuilder $searchCriteriaBuilder,
        private readonly SortOrderBuilder $sortOrderBuilder,
        private readonly CustomerSession $customerSession,
        private readonly LoggerInterface $logger,
        private readonly RequestInterface $request,
        private readonly ConversationStoreScope $conversationStoreScope
    ) {
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
            $scope = $this->conversationStoreScope->current();

            $sortOrder = $this->sortOrderBuilder
                ->setField('updated_at')
                ->setDirection('DESC')
                ->create();

            $searchCriteria = $this->searchCriteriaBuilder
                ->addFilter('customer_id', $customerId)
                ->addFilter('store_id', $scope['store_id'])
                ->addFilter('website_id', $scope['website_id'])
                ->addFilter('is_archived', 0)
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
            $this->logger->error('CONVERSATIONS ERROR', ['exception' => $e]);
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
