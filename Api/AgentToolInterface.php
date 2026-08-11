<?php
declare(strict_types=1);

namespace Afd\AI\Api;

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
     * @param bool|null $directAddOnly
     * @param bool|null $exactIdentity
     * @param string|null $excludedTerms JSON list of product-name terms explicitly rejected by the shopper
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
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
    );

    /**
     * Get the current salable quantity for a product or a selected variant.
     *
     * @param string $sku
     * @param string|null $selectedOptions JSON object of Magento variant attribute code to selected label
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getProductAvailability(string $sku, string $selectedOptions = '');

    /**
     * List product categories available in the store
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function listCategories();

    /**
     * Add product to cart
     *
     * @param string $sku
     * @param int|null $qty
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function addToCart(string $sku, int $qty = 1);

    /**
     * Update product quantity in cart
     *
     * @param string $sku
     * @param int $qty
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function updateCartItem(string $sku, int $qty);

    /**
     * Remove product from cart
     *
     * @param string $sku
     * @param string|null $cartTarget checkout or quote
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function removeFromCart(string $sku, string $cartTarget = 'checkout');

    /**
     * Get current customer information
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getCustomerInfo();

    /**
     * Get recent orders of current customer
     *
     * @param int|null $limit
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getRecentOrders(int $limit = 5);

    /**
     * Get customer addresses
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getCustomerAddresses();

    /**
     * Get product details for comparison
     *
     * @param string $sku1
     * @param string $sku2
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function compareProducts(string $sku1, string $sku2);

    /**
     * Get active coupon codes for store
     *
     * @return \Afd\AI\Api\Data\ToolResponseInterface
     */
    public function getActiveCoupons();
}
