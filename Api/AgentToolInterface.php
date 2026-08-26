<?php
declare(strict_types=1);

namespace Afd\AI\Api;

use Afd\AI\Api\Data\ToolResponseInterface;

interface AgentToolInterface
{
    /**
     * Search products
     *
     * @param string $query
     * @param int|null $limit
     * @param int|null $page
     * @param int|null $categoryId
     * @param float|null $minPrice
     * @param float|null $maxPrice
     * @param string|null $priceCurrency ISO 4217 currency of explicit price constraints
     * @param bool|null $directAddOnly
     * @param bool|null $exactIdentity
     * @param string|null $excludedTerms JSON list of product-name terms explicitly rejected by the shopper
     * @param string|null $requiredVariantAttributeCode Configurable attribute code returned by Magento discovery
     * @param string|null $requiredVariantOptionValues JSON list of exact option labels required for that attribute
     * @param string|null $excludedVariantOptionValues JSON list of configurable values the shopper does not want
     * @param int|null $customerGroupId Magento-signed shopper customer group used for indexed prices
     * @param int|null $customerId Magento-signed customer identity, revalidated by Magento when present
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function searchProducts(
        string $query,
        int $limit = 5,
        int $page = 1,
        int $categoryId = 0,
        float $minPrice = 0.0,
        float $maxPrice = 0.0,
        string $priceCurrency = '',
        bool $directAddOnly = false,
        bool $exactIdentity = false,
        string $excludedTerms = '',
        string $requiredVariantAttributeCode = '',
        string $requiredVariantOptionValues = '',
        string $excludedVariantOptionValues = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface;

    /**
     * Get the current salable quantity for a product or a selected variant.
     *
     * @param string $sku
     * @param string|null $selectedOptions JSON object of Magento variant attribute code to selected label
     * @param int|null $customerGroupId Magento-signed shopper group used for catalogue permissions
     * @param int|null $customerId Magento-signed customer identity, revalidated by Magento when present
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getProductAvailability(
        string $sku,
        string $selectedOptions = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface;

    /**
     * List product categories available in the store
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function listCategories(int $customerGroupId = 0, int $customerId = 0): ToolResponseInterface;

    /**
     * List actual configurable attributes and values available in one verified category.
     *
     * @param int $categoryId
     * @param int|null $customerGroupId Magento-signed shopper customer group used for catalogue visibility
     * @param int|null $customerId Magento-signed customer identity, revalidated by Magento when present
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function listVariantAttributes(
        int $categoryId,
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface;

    /**
     * Add product to cart
     *
     * @param string $sku
     * @param int|null $qty
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function addToCart(string $sku, int $qty = 1): ToolResponseInterface;

    /**
     * Update product quantity in cart
     *
     * @param string $sku
     * @param int $qty
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function updateCartItem(string $sku, int $qty): ToolResponseInterface;

    /**
     * Remove product from cart
     *
     * @param string $sku
     * @param string|null $cartTarget checkout or quote
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function removeFromCart(string $sku, string $cartTarget = 'checkout'): ToolResponseInterface;

    /**
     * Get current customer information
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getCustomerInfo(): ToolResponseInterface;

    /**
     * Get recent orders of current customer
     *
     * @param int|null $limit
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getRecentOrders(int $limit = 5): ToolResponseInterface;

    /**
     * Get customer addresses
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getCustomerAddresses(): ToolResponseInterface;

    /**
     * Get product details for comparison
     *
     * @param string $sku1
     * @param string $sku2
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function compareProducts(
        string $sku1,
        string $sku2,
        int $customerGroupId = 0,
        int $customerId = 0
    ): ToolResponseInterface;

    /**
     * Get active coupon codes for store
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getActiveCoupons(int $customerGroupId = 0, int $customerId = 0): ToolResponseInterface;
}
