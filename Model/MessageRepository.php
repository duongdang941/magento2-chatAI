<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\Data\MessageInterface;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\MessageFactory;
use Afd\AI\Model\ResourceModel\Message as MessageResource;
use Afd\AI\Model\ResourceModel\Message\CollectionFactory as MessageCollectionFactory;
use Magento\Framework\Api\SearchCriteria\CollectionProcessorInterface;
use Magento\Framework\Api\SearchResultsInterfaceFactory;
use Magento\Framework\Exception\CouldNotDeleteException;
use Magento\Framework\Exception\CouldNotSaveException;
use Magento\Framework\Exception\NoSuchEntityException;

class MessageRepository implements MessageRepositoryInterface
{
    public function __construct(
        protected readonly MessageResource $resource,
        protected readonly MessageFactory $messageFactory,
        protected readonly MessageCollectionFactory $messageCollectionFactory,
        protected readonly SearchResultsInterfaceFactory $searchResultsFactory,
        protected readonly CollectionProcessorInterface $collectionProcessor
    ) {
    }

    public function save(MessageInterface $message)
    {
        try {
            $this->resource->save($message);
        } catch (\Exception $exception) {
            throw new CouldNotSaveException(__($exception->getMessage()));
        }
        return $message;
    }

    public function getById($entityId)
    {
        $message = $this->messageFactory->create();
        $this->resource->load($message, $entityId);
        if (!$message->getId()) {
            throw new NoSuchEntityException(__('Message with id "%1" does not exist.', $entityId));
        }
        return $message;
    }

    public function getList(\Magento\Framework\Api\SearchCriteriaInterface $searchCriteria)
    {
        $collection = $this->messageCollectionFactory->create();
        $this->collectionProcessor->process($searchCriteria, $collection);
        
        $searchResults = $this->searchResultsFactory->create();
        $searchResults->setSearchCriteria($searchCriteria);
        $searchResults->setItems($collection->getItems());
        $searchResults->setTotalCount($collection->getSize());
        return $searchResults;
    }

    public function delete(MessageInterface $message)
    {
        try {
            $this->resource->delete($message);
        } catch (\Exception $exception) {
            throw new CouldNotDeleteException(__($exception->getMessage()));
        }
        return true;
    }

    public function deleteById($entityId)
    {
        return $this->delete($this->getById($entityId));
    }
}
