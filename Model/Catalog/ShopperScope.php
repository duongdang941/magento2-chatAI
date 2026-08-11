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
        private readonly int $customerGroupId
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
