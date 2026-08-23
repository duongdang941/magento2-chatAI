<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\Data\ConversationInterface;
use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\ConversationFactory;
use Afd\AI\Model\ResourceModel\Conversation as ConversationResource;
use Afd\AI\Model\ResourceModel\Conversation\CollectionFactory as ConversationCollectionFactory;
use Magento\Framework\Api\SearchCriteria\CollectionProcessorInterface;
use Magento\Framework\Api\SearchResultsInterfaceFactory;
use Magento\Framework\Exception\CouldNotDeleteException;
use Magento\Framework\Exception\CouldNotSaveException;
use Magento\Framework\Exception\NoSuchEntityException;

class ConversationRepository implements ConversationRepositoryInterface
{
    public function __construct(
        protected readonly ConversationResource $resource,
        protected readonly ConversationFactory $conversationFactory,
        protected readonly ConversationCollectionFactory $conversationCollectionFactory,
        protected readonly SearchResultsInterfaceFactory $searchResultsFactory,
        protected readonly CollectionProcessorInterface $collectionProcessor
    ) {
    }

    public function save(ConversationInterface $conversation)
    {
        try {
            $this->resource->save($conversation);
        } catch (\Exception $exception) {
            throw new CouldNotSaveException(__($exception->getMessage()));
        }
        return $conversation;
    }

    public function getById($conversationId)
    {
        $conversation = $this->conversationFactory->create();
        $this->resource->load($conversation, $conversationId);
        if (!$conversation->getId()) {
            throw new NoSuchEntityException(__('Conversation with id "%1" does not exist.', $conversationId));
        }
        return $conversation;
    }

    public function getList(\Magento\Framework\Api\SearchCriteriaInterface $searchCriteria)
    {
        $collection = $this->conversationCollectionFactory->create();
        $this->collectionProcessor->process($searchCriteria, $collection);

        $searchResults = $this->searchResultsFactory->create();
        $searchResults->setSearchCriteria($searchCriteria);
        $searchResults->setItems($collection->getItems());
        $searchResults->setTotalCount($collection->getSize());
        return $searchResults;
    }

    public function delete(ConversationInterface $conversation)
    {
        try {
            $this->resource->delete($conversation);
        } catch (\Exception $exception) {
            throw new CouldNotDeleteException(__($exception->getMessage()));
        }
        return true;
    }

    public function deleteById($conversationId)
    {
        return $this->delete($this->getById($conversationId));
    }
}
