<?php

declare(strict_types=1);

namespace Afd\AI\Block\Chat;

use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Magento\Catalog\Model\Product;
use Magento\Catalog\Pricing\Price\FinalPrice;
use Magento\Catalog\Helper\Product as ProductHelper;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Framework\Data\Helper\PostHelper;
use Magento\Framework\Pricing\Render;
use Magento\Framework\View\Element\Template;

/**
 * Block for rendering product card grid in AI chat messages
 */
class ProductGrid extends Template
{
    private ?Collection $products = null;

    private ?Render $priceRenderer = null;

    public function __construct(
        Template\Context $context,
        private readonly ProductHelper $productHelper,
        private readonly PostHelper $postHelper,
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
     * Render a product price with Magento's native price renderer.
     *
     * Product types own their pricing calculation in Magento. In particular,
     * configurable products resolve their price from eligible child products;
     * reading the parent collection's final_price field directly can therefore
     * display 0.00. Delegating to the renderer also preserves catalog rules,
     * customer-group prices, tax settings and special-price presentation.
     */
    public function getProductPriceHtml(Product $product): string
    {
        if ($this->priceRenderer instanceof Render) {
            return $this->renderProductPrice($this->priceRenderer, $product);
        }

        $priceRenderer = $this->getLayout()->getBlock('product.price.render.default');

        // The chat grid can also be rendered by an AJAX/API context whose
        // page layout has not loaded the default price block. Keep the same
        // Magento renderer, with the same price-render handle, in that case.
        if (!$priceRenderer instanceof Render) {
            $priceRenderer = $this->getLayout()->createBlock(
                Render::class,
                'afd.ai.product.price.render.' . spl_object_id($this),
                [
                    'data' => [
                        'price_render_handle' => 'catalog_product_prices',
                        'use_link_for_as_low_as' => true,
                    ],
                ]
            );
        }

        if (!$priceRenderer instanceof Render) {
            return '';
        }

        // Match Magento's product-list block. The renderer reads this flag
        // while building each type-specific price box.
        $priceRenderer->setData('is_product_list', true);
        $this->priceRenderer = $priceRenderer;

        return $this->renderProductPrice($priceRenderer, $product);
    }

    private function renderProductPrice(Render $priceRenderer, Product $product): string
    {
        return $priceRenderer->render(
            FinalPrice::PRICE_CODE,
            $product,
            [
                'price_id' => 'afd-ai-product-price-' . (int)$product->getId(),
                'display_minimal_price' => true,
                'zone' => Render::ZONE_ITEM_LIST,
                'list_category_page' => true,
            ]
        );
    }
}
