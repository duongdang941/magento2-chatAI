<?php
declare(strict_types=1);

namespace Afd\AI\Model\Conversation;

use Magento\Store\Model\StoreManagerInterface;

/** Resolves and verifies the active storefront boundary for conversations. */
class ConversationStoreScope
{
    public function __construct(private readonly StoreManagerInterface $storeManager)
    {
    }

    /** @return array{store_id:int,website_id:int} */
    public function current(): array
    {
        $store = $this->storeManager->getStore();

        return [
            'store_id' => (int)$store->getId(),
            'website_id' => (int)$store->getWebsiteId(),
        ];
    }

    public function matches(object $conversation): bool
    {
        $scope = $this->current();

        return (int)$conversation->getData('store_id') === $scope['store_id']
            && (int)$conversation->getData('website_id') === $scope['website_id'];
    }
}
