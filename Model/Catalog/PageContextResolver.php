<?php
declare(strict_types=1);

namespace Afd\AI\Model\Catalog;

use Magento\Catalog\Model\Category;
use Magento\Catalog\Model\Product;
use Magento\Framework\Registry;

/**
 * Produces page metadata from Magento registry objects, never by inspecting a
 * URL string. The data is signed into the short-lived WebSocket ticket.
 */
class PageContextResolver
{
    public function __construct(private readonly Registry $registry)
    {
    }

    /** @return array<string, int|string> */
    public function resolve(): array
    {
        $product = $this->registry->registry('current_product');
        if ($product instanceof Product && (int)$product->getId() > 0) {
            return [
                'type' => 'product',
                'product_id' => (int)$product->getId(),
                'sku' => mb_substr(trim((string)$product->getSku()), 0, 64),
                'name' => mb_substr(trim((string)$product->getName()), 0, 160),
            ];
        }

        $category = $this->registry->registry('current_category');
        if ($category instanceof Category && (int)$category->getId() > 0) {
            return [
                'type' => 'category',
                'category_id' => (int)$category->getId(),
                'name' => mb_substr(trim((string)$category->getName()), 0, 160),
            ];
        }

        return [];
    }
}
