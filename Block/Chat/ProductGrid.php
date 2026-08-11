<?php

declare(strict_types=1);

namespace Afd\AI\Block\Chat;

use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Magento\Catalog\Helper\Product as ProductHelper;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Framework\Data\Helper\PostHelper;
use Magento\Framework\Pricing\PriceCurrencyInterface;
use Magento\Framework\View\Element\Template;

/**
 * Block for rendering product card grid in AI chat messages
 */
class ProductGrid extends Template
{
    private ?Collection $products = null;

    public function __construct(
        Template\Context $context,
        private readonly ProductHelper $productHelper,
        private readonly PostHelper $postHelper,
        private readonly PriceCurrencyInterface $priceCurrency,
        private readonly DirectAddEligibility $directAddEligibility,
        private readonly SaleQuantityPolicy $saleQuantityPolicy,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    /**
     * Set the product collection
     */
    public function setProducts(Collection $collection): self
    {
        $this->products = $collection;
        return $this;
    }

    /**
     * Get products
     */
    public function getProducts(): ?Collection
    {
        return $this->products;
    }

    public function getProductImageUrl($product): string
    {
        return (string)$this->productHelper->getSmallImageUrl($product);
    }

    public function canAddToCartDirectly($product): bool
    {
        return $this->directAddEligibility->canAddToCartDirectly($product);
    }

    public function getAddToCartPostData($product): array
    {
        $defaultQty = $this->saleQuantityPolicy->getPolicy($product)['default_add_qty'] ?? 1;
        $payload = json_decode(
            $this->postHelper->getPostData(
                $this->getUrl('checkout/cart/add'),
                [
                    'product' => (int)$product->getId(),
                    'qty' => $defaultQty,
                    'uenc' => '__AFD_UENC__'
                ]
            ),
            true
        );

        if (!is_array($payload)) {
            return [
                'action' => $this->getUrl('checkout/cart/add'),
                'data' => [
                    'product' => (int)$product->getId(),
                    'qty' => $defaultQty,
                    'uenc' => '__AFD_UENC__'
                ]
            ];
        }

        return $payload;
    }

    /**
     * Get formatted price
     */
    public function getFormattedPrice($product): string
    {
        return $this->priceCurrency->format($product->getFinalPrice(), false);
    }

    /**
     * Get original price formatted (show only if higher than final price)
     */
    public function getFormattedOriginalPrice($product): ?string
    {
        $originalPrice = (float)$product->getPrice();
        $finalPrice = (float)$product->getFinalPrice();

        if ($originalPrice > $finalPrice) {
            return $this->priceCurrency->format($originalPrice, false);
        }

        return null;
    }
}
