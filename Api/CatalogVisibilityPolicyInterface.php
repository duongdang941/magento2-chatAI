<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Model\Catalog\ShopperScope;

/**
 * Applies shopper-scoped catalogue visibility independently of a storefront
 * PHP session. Implementations must be safe for Web API and Node requests.
 */
interface CatalogVisibilityPolicyInterface
{
    /** @param mixed $collection */
    public function applyToProductCollection(
        mixed $collection,
        ShopperScope $shopperScope,
        bool $requireCatalogVisibility = true,
        bool $requireEnabled = true
    ): void;

    /** @param mixed $collection */
    public function applyToCategoryCollection(mixed $collection, ShopperScope $shopperScope): void;
}
