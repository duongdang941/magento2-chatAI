<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Api\Data\ConversationInterface;
use Magento\Framework\Api\SearchCriteriaInterface;

interface ConversationRepositoryInterface
{
    /**
     * @param ConversationInterface $conversation
     * @return ConversationInterface
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function save(ConversationInterface $conversation);

    /**
     * @param int $conversationId
     * @return ConversationInterface
     * @throws \Magento\Framework\Exception\NoSuchEntityException
     */
    public function getById($conversationId);

    /**
     * @param SearchCriteriaInterface $searchCriteria
     * @return \Magento\Framework\Api\SearchResultsInterface
     */
    public function getList(SearchCriteriaInterface $searchCriteria);

    /**
     * @param ConversationInterface $conversation
     * @return bool
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function delete(ConversationInterface $conversation);

    /**
     * @param int $conversationId
     * @return bool
     * @throws \Magento\Framework\Exception\NoSuchEntityException
     * @throws \Magento\Framework\Exception\LocalizedException
     */
    public function deleteById($conversationId);
}
