<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Api\Data\MessageInterface;
use Magento\Framework\Api\SearchCriteriaInterface;

interface MessageRepositoryInterface
{
    /**
     * @param MessageInterface $message
     * @return MessageInterface
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function save(MessageInterface $message);

    /**
     * @param int $entityId
     * @return MessageInterface
     * @throws \Magento\Framework\Exception\NoSuchEntityException
     */
    public function getById($entityId);

    /**
     * @param SearchCriteriaInterface $searchCriteria
     * @return \Magento\Framework\Api\SearchResultsInterface
     */
    public function getList(SearchCriteriaInterface $searchCriteria);

    /**
     * @param MessageInterface $message
     * @return bool
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function delete(MessageInterface $message);

    /**
     * @param int $entityId
     * @return bool
     * @throws \Magento\Framework\Exception\NoSuchEntityException
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function deleteById($entityId);
}
