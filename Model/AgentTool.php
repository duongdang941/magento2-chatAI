<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\AgentToolInterface;
use Afd\AI\Model\Tool\CartTool;
use Afd\AI\Model\Tool\CatalogSearchTool;
use Afd\AI\Model\Tool\CommerceTool;
use Afd\AI\Model\Tool\CustomerProfileTool;
use Afd\AI\Model\Tool\ProductAvailabilityTool;

/**
 * Stable Web API facade for AI tools.
 *
 * The public interface remains unchanged. Each concern is delegated to a
 * narrowly-scoped Magento service so catalogue, customer and cart behaviour
 * can evolve and be tested independently.
 */
class AgentTool implements AgentToolInterface
{
    private CatalogSearchTool $catalogSearchTool;
    private ProductAvailabilityTool $productAvailabilityTool;
    private CartTool $cartTool;
    private CustomerProfileTool $customerProfileTool;
    private CommerceTool $commerceTool;

    public function __construct(
        CatalogSearchTool $catalogSearchTool,
        ProductAvailabilityTool $productAvailabilityTool,
        CartTool $cartTool,
        CustomerProfileTool $customerProfileTool,
        CommerceTool $commerceTool
    ) {
        $this->catalogSearchTool = $catalogSearchTool;
        $this->productAvailabilityTool = $productAvailabilityTool;
        $this->cartTool = $cartTool;
        $this->customerProfileTool = $customerProfileTool;
        $this->commerceTool = $commerceTool;
    }

    public function searchProducts(
        string $query,
        int $limit = 5,
        int $page = 1,
        int $categoryId = 0,
        float $minPrice = 0.0,
        float $maxPrice = 0.0,
        bool $directAddOnly = false,
        bool $exactIdentity = false,
        string $excludedTerms = ''
    ) {
        return $this->catalogSearchTool->searchProducts(
            $query,
            $limit,
            $page,
            $categoryId,
            $minPrice,
            $maxPrice,
            $directAddOnly,
            $exactIdentity,
            $excludedTerms
        );
    }

    public function getProductAvailability(string $sku, string $selectedOptions = '')
    {
        return $this->productAvailabilityTool->getProductAvailability($sku, $selectedOptions);
    }

    public function listCategories()
    {
        return $this->catalogSearchTool->listCategories();
    }

    public function addToCart(string $sku, int $qty = 1)
    {
        return $this->cartTool->addToCart($sku, $qty);
    }

    public function updateCartItem(string $sku, int $qty)
    {
        return $this->cartTool->updateCartItem($sku, $qty);
    }

    public function removeFromCart(string $sku, string $cartTarget = 'checkout')
    {
        return $this->cartTool->removeFromCart($sku, $cartTarget);
    }

    public function getCustomerInfo()
    {
        return $this->customerProfileTool->getCustomerInfo();
    }

    public function getRecentOrders(int $limit = 5)
    {
        return $this->customerProfileTool->getRecentOrders($limit);
    }

    public function getCustomerAddresses()
    {
        return $this->customerProfileTool->getCustomerAddresses();
    }

    public function compareProducts(string $sku1, string $sku2)
    {
        return $this->commerceTool->compareProducts($sku1, $sku2);
    }

    public function getActiveCoupons()
    {
        return $this->commerceTool->getActiveCoupons();
    }
}
