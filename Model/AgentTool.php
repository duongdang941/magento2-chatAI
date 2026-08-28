<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\AgentToolInterface;
use Afd\AI\Api\Data\ToolResponseInterface;
use Afd\AI\Model\Tool\CartTool;
use Afd\AI\Model\Tool\CatalogSearchTool;
use Afd\AI\Model\Tool\CommerceTool;
use Afd\AI\Model\Tool\CustomerProfileTool;
use Afd\AI\Model\Tool\ProductAvailabilityTool;
use Afd\AI\Model\Security\NodeRequestAuthorizer;

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
    private NodeRequestAuthorizer $nodeRequestAuthorizer;

    public function __construct(
        CatalogSearchTool $catalogSearchTool,
        ProductAvailabilityTool $productAvailabilityTool,
        CartTool $cartTool,
        CustomerProfileTool $customerProfileTool,
        CommerceTool $commerceTool,
        NodeRequestAuthorizer $nodeRequestAuthorizer
    ) {
        $this->catalogSearchTool = $catalogSearchTool;
        $this->productAvailabilityTool = $productAvailabilityTool;
        $this->cartTool = $cartTool;
        $this->customerProfileTool = $customerProfileTool;
        $this->commerceTool = $commerceTool;
        $this->nodeRequestAuthorizer = $nodeRequestAuthorizer;
    }

    public function searchProducts(
        string $query,
        int $limit = 5,
        int $page = 1,
        int $categoryId = 0,
        float $minPrice = 0.0,
        float $maxPrice = 0.0,
        string $priceCurrency = '',
        bool $directAddOnly = false,
        bool $browseAll = false,
        bool $exactIdentity = false,
        bool $exactSku = false,
        string $excludedTerms = '',
        string $requiredVariantAttributeCode = '',
        string $requiredVariantOptionValues = '',
        string $excludedVariantOptionValues = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->catalogSearchTool->searchProducts(
            $query,
            $limit,
            $page,
            $categoryId,
            $minPrice,
            $maxPrice,
            $priceCurrency,
            $directAddOnly,
            $browseAll,
            $exactIdentity,
            $exactSku,
            $excludedTerms,
            $requiredVariantAttributeCode,
            $requiredVariantOptionValues,
            $excludedVariantOptionValues,
            $customerGroupId,
            $customerId
        );
    }

    public function getProductAvailability(
        string $sku,
        string $selectedOptions = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->productAvailabilityTool->getProductAvailability(
            $sku,
            $selectedOptions,
            $customerGroupId,
            $customerId
        );
    }

    public function listCategories(int $customerGroupId = 0, int $customerId = 0): ToolResponseInterface
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->catalogSearchTool->listCategories($customerGroupId, $customerId);
    }

    public function listVariantAttributes(
        int $categoryId,
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->catalogSearchTool->listVariantAttributes($categoryId, $customerGroupId, $customerId);
    }

    public function addToCart(string $sku, int $qty = 1): ToolResponseInterface
    {
        return $this->cartTool->addToCart($sku, $qty);
    }

    public function updateCartItem(string $sku, int $qty): ToolResponseInterface
    {
        return $this->cartTool->updateCartItem($sku, $qty);
    }

    public function removeFromCart(string $sku, string $cartTarget = 'checkout'): ToolResponseInterface
    {
        return $this->cartTool->removeFromCart($sku, $cartTarget);
    }

    public function getCustomerInfo(): ToolResponseInterface
    {
        return $this->customerProfileTool->getCustomerInfo();
    }

    public function getRecentOrders(int $limit = 5): ToolResponseInterface
    {
        return $this->customerProfileTool->getRecentOrders($limit);
    }

    public function getCustomerAddresses(): ToolResponseInterface
    {
        return $this->customerProfileTool->getCustomerAddresses();
    }

    public function compareProducts(
        string $sku1,
        string $sku2,
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->commerceTool->compareProducts($sku1, $sku2, $customerGroupId, $customerId);
    }

    public function getActiveCoupons(int $customerGroupId = 0, int $customerId = 0): ToolResponseInterface
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return $this->commerceTool->getActiveCoupons($customerGroupId, $customerId);
    }
}
