<?php

declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\State;

/**
 * Renders product cards as HTML using Block + PHTML templates
 */
class ProductRenderer implements ProductRendererInterface
{
    public function __construct(
        private readonly \Magento\Catalog\Model\ResourceModel\Product\CollectionFactory $productCollectionFactory,
        private readonly \Magento\Framework\View\LayoutInterface $layout,
        private readonly State $appState,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly CustomerSession $customerSession,
        private readonly CatalogVisibilityPolicyInterface $catalogVisibilityPolicy
    ) {
    }

    /**
     * @inheritdoc
     */
    public function renderProducts(
        string $ids,
        ?int $customerGroupId = null,
        ?int $trustedCustomerId = null
    ): string
    {
        $productIds = array_filter(array_map('intval', explode(',', $ids)));

        if (empty($productIds)) {
            return '';
        }

        $shopperScope = $this->shopperScopeResolver->resolve(
            $customerGroupId ?? (int)$this->customerSession->getCustomerGroupId(),
            max(0, (int)$trustedCustomerId)
        );
        $loadCollection = function () use ($productIds, $shopperScope): Collection {
            $collection = $this->productCollectionFactory->create();
            $this->catalogVisibilityPolicy->applyToProductCollection($collection, $shopperScope);
            $collection->addIdFilter($productIds)
                ->addAttributeToSelect(['name', 'price', 'special_price', 'image', 'url_key', 'small_image', 'thumbnail'])
                ->addUrlRewrite();
            foreach ($collection as $product) {
                $product->setCustomerGroupId($shopperScope->getCustomerGroupId());
            }

            return $collection;
        };

        if ($this->isFrontendArea()) {
            return $this->renderProductCollection($loadCollection());
        }

        return $this->appState->emulateAreaCode(
            \Magento\Framework\App\Area::AREA_FRONTEND,
            fn (): string => $this->renderProductCollection($loadCollection())
        );
    }

    public function renderProductCollection(Collection $collection): string
    {
        /** @var \Afd\AI\Block\Chat\ProductGrid $block */
        $block = $this->layout->createBlock(\Afd\AI\Block\Chat\ProductGrid::class);
        $block->setTemplate('Afd_AI::chat/product-grid.phtml');
        $block->setProducts($collection);

        return $block->toHtml();
    }

    private function isFrontendArea(): bool
    {
        try {
            return $this->appState->getAreaCode() === \Magento\Framework\App\Area::AREA_FRONTEND;
        } catch (\Magento\Framework\Exception\LocalizedException $exception) {
            return false;
        }
    }
}
