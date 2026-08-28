<?php
declare(strict_types=1);

namespace Afd\AI\Model\Catalog;

/**
 * Immutable Magento catalogue context for one shopper connection.
 *
 * Store values determine website membership, translated attributes, URLs and
 * currency. Customer group determines the indexed final and tier prices.
 */
class ShopperScope
{
    public function __construct(
        private readonly int $storeId,
        private readonly string $storeCode,
        private readonly int $websiteId,
        private readonly int $customerGroupId,
        private readonly string $catalogLanguage = ''
    ) {
    }

    public function getStoreId(): int
    {
        return $this->storeId;
    }

    public function getStoreCode(): string
    {
        return $this->storeCode;
    }

    public function getWebsiteId(): int
    {
        return $this->websiteId;
    }

    public function getCustomerGroupId(): int
    {
        return $this->customerGroupId;
    }

    /**
     * Store-view locale language used by catalogue names and category labels.
     * This is deliberately separate from the shopper's response language.
     */
    public function getCatalogLanguage(): string
    {
        return $this->catalogLanguage;
    }

    /** @return array<string, int|string> */
    public function toArray(): array
    {
        return [
            'store_id' => $this->storeId,
            'store_code' => $this->storeCode,
            'website_id' => $this->websiteId,
            'customer_group_id' => $this->customerGroupId,
        ];
    }
}
