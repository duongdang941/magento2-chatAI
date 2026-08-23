<?php
declare(strict_types=1);

namespace Afd\AI\Model\Product;

use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Catalog\Model\Product\Type\AbstractType;
use Magento\Framework\DataObject;

/**
 * Establishes whether Magento can add one product without any shopper input.
 *
 * Product type and the legacy required_options attribute are not sufficient:
 * a simple product can still require a custom option, while the legacy flag
 * can remain set after its required option was removed. Magento's own cart
 * preparation is the single source of truth for this decision.
 */
class DirectAddEligibility
{
    /** @var array<int, bool> */
    private array $eligibilityByProductId = [];

    public function __construct(
        private readonly ProductRepositoryInterface $productRepository,
        private readonly SaleQuantityPolicy $saleQuantityPolicy
    ) {
    }

    public function canAddToCartDirectly($product): bool
    {
        $productId = (int)($product?->getId() ?? 0);
        if ($productId < 1) {
            return false;
        }

        if (array_key_exists($productId, $this->eligibilityByProductId)) {
            return $this->eligibilityByProductId[$productId];
        }

        try {
            // Collections used by the card renderer intentionally select a
            // small attribute set. Reload the product so custom options are
            // present when Magento validates the buy request.
            $product = $this->productRepository->getById($productId, false, null, true);
            // Chat never owns a product's selection UI. Even an optional
            // custom option must be chosen on the product page so the shopper
            // can see its price, dependency, and storefront validation.
            if ($product->getTypeId() !== 'simple'
                || !$product->isSaleable()
                || $this->hasCustomerOptions($product)) {
                return $this->eligibilityByProductId[$productId] = false;
            }

            $quantityPolicy = $this->saleQuantityPolicy->getPolicy($product);
            $defaultQty = $quantityPolicy['default_add_qty'];
            if ($quantityPolicy['resolved'] !== true || $defaultQty === null) {
                return $this->eligibilityByProductId[$productId] = false;
            }

            $buyRequest = new DataObject([
                'product' => $productId,
                'qty' => $defaultQty,
            ]);
            $preparedProducts = $product->getTypeInstance()->prepareForCartAdvanced(
                $buyRequest,
                $product,
                AbstractType::PROCESS_MODE_FULL
            );

            return $this->eligibilityByProductId[$productId]
                = is_array($preparedProducts) && $preparedProducts !== [];
        } catch (\Throwable) {
            // A card must never promise direct add-to-cart when Magento could
            // not validate the same request it would receive from the cart.
            return $this->eligibilityByProductId[$productId] = false;
        }
    }

    private function hasCustomerOptions($product): bool
    {
        // has_options is the persisted Magento product flag. Reading the data
        // field rather than the magic getHasOptions() accessor also keeps this
        // boundary explicit for lightweight product objects.
        return (bool)$product->getData('has_options');
    }
}
