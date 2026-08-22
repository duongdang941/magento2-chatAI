<?php

declare(strict_types=1);

namespace Afd\AI\Api;

use Magento\Catalog\Model\ResourceModel\Product\Collection;

/**
 * Interface for rendering product cards as HTML
 */
interface ProductRendererInterface
{
    /**
     * Render product cards HTML by product IDs
     *
     * @param string $ids Comma-separated product IDs
     * @param int|null $customerGroupId Magento-verified customer group
     * @param int|null $trustedCustomerId Magento-verified customer identity
     * @return string Rendered HTML
     */
    public function renderProducts(
        string $ids,
        ?int $customerGroupId = null,
        ?int $trustedCustomerId = null
    ): string;

    /**
     * Render product cards HTML from a preloaded collection to avoid requerying.
     */
    public function renderProductCollection(Collection $collection): string;
}
