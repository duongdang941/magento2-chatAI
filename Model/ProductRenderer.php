<?php

declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ProductRendererInterface;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Framework\App\State;

/**
 * Renders product cards as HTML using Block + PHTML templates
 */
class ProductRenderer implements ProductRendererInterface
{
    public function __construct(
        private readonly \Magento\Catalog\Model\ResourceModel\Product\CollectionFactory $productCollectionFactory,
        private readonly \Magento\Framework\View\LayoutInterface $layout,
        private readonly State $appState
    ) {
    }

    /**
     * @inheritdoc
     */
    public function renderProducts(string $ids): string
    {
        $productIds = array_filter(array_map('intval', explode(',', $ids)));

        if (empty($productIds)) {
            return '';
        }

        $loadCollection = function () use ($productIds): Collection {
            $collection = $this->productCollectionFactory->create();
            return $collection->addIdFilter($productIds)
                ->addAttributeToSelect(['name', 'price', 'special_price', 'image', 'url_key', 'small_image', 'thumbnail'])
                ->addAttributeToFilter('status', ['eq' => \Magento\Catalog\Model\Product\Attribute\Source\Status::STATUS_ENABLED])
                ->addAttributeToFilter('visibility', [
                    'in' => [
                        \Magento\Catalog\Model\Product\Visibility::VISIBILITY_BOTH,
                        \Magento\Catalog\Model\Product\Visibility::VISIBILITY_IN_CATALOG,
                        \Magento\Catalog\Model\Product\Visibility::VISIBILITY_IN_SEARCH
                    ]
                ])
                ->addUrlRewrite()
                ->addFinalPrice();
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
