<?php

declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Area;
use Magento\Framework\App\State;
use Magento\Framework\View\DesignInterface;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Renders product cards as HTML using Block + PHTML templates
 */
class ProductRenderer implements ProductRendererInterface
{
    public function __construct(
        private readonly \Magento\Catalog\Model\ResourceModel\Product\CollectionFactory $productCollectionFactory,
        private readonly \Magento\Framework\View\LayoutInterface $layout,
        private readonly State $appState,
        private readonly DesignInterface $design,
        private readonly StoreManagerInterface $storeManager,
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

        $renderCards = function () use ($loadCollection, $shopperScope): string {
            // The REST call that supplies a chat card runs in webapi_rest.
            // Area emulation alone leaves the design in Magento's virtual
            // `_view` namespace, which makes a catalog placeholder URL 404
            // under a real storefront theme. Select the configured storefront
            // theme for this signed store before the template resolves its
            // fallback image asset; no theme path is hard-coded here.
            $store = $this->storeManager->getStore($shopperScope->getStoreId());
            $theme = $this->design->getConfigurationDesignTheme(
                Area::AREA_FRONTEND,
                ['store' => $store]
            );
            $this->design->setDesignTheme($theme, Area::AREA_FRONTEND);

            return $this->renderProductCollection($loadCollection());
        };

        if ($this->isFrontendArea()) {
            return $renderCards();
        }

        return $this->appState->emulateAreaCode(Area::AREA_FRONTEND, $renderCards);
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
