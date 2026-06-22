<?php
declare(strict_types=1);

namespace Afd\AI\Model\Product;

use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Catalog\Model\ResourceModel\Product\CollectionFactory as ProductCollectionFactory;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\ProductAlert\Model\ResourceModel\Stock\CollectionFactory as StockAlertCollectionFactory;
use Magento\ProductAlert\Model\StockFactory;
use Magento\ProductAlert\Model\ResourceModel\Stock as StockAlertResource;
use Magento\Store\Model\ScopeInterface;

class BackInStockSubscription
{
    public function __construct(
        private readonly ProductCollectionFactory $productCollectionFactory,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly CatalogVisibilityPolicyInterface $catalogVisibilityPolicy,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly StockFactory $stockFactory,
        private readonly StockAlertResource $stockAlertResource,
        private readonly StockAlertCollectionFactory $stockAlertCollectionFactory,
        private readonly ActionRateLimiter $rateLimiter
    ) {
    }

    /** @return array<string, mixed> */
    public function subscribe(int $customerId, string $sku): array
    {
        if ($customerId < 1) {
            return ['status' => 'requires_customer_action', 'reason' => 'not_logged_in', 'message' => __('Please sign in to receive a back-in-stock notification.')->render()];
        }
        if (!$this->scopeConfig->isSetFlag('catalog/productalert/allow_stock', ScopeInterface::SCOPE_STORE)) {
            return ['status' => 'unavailable', 'reason' => 'stock_alerts_disabled', 'message' => __('Back-in-stock notifications are currently unavailable.')->render()];
        }
        $scope = $this->shopperScopeResolver->resolve(0, $customerId);
        $product = $this->getVisibleProduct(trim($sku), $scope);
        if ($product === null) {
            return ['status' => 'requires_customer_action', 'reason' => 'product_not_found', 'message' => __('That product was not found.')->render()];
        }
        $websiteId = $scope->getWebsiteId();
        $existing = $this->stockAlertCollectionFactory->create()
            ->addFieldToFilter('customer_id', $customerId)
            ->addFieldToFilter('product_id', (int)$product->getId())
            ->addFieldToFilter('website_id', $websiteId)
            ->setPageSize(1)
            ->getFirstItem();
        if ($existing->getId()) {
            return ['status' => 'success', 'already_subscribed' => true, 'sku' => (string)$product->getSku(), 'message' => __('You are already subscribed to this product.')->render()];
        }
        $throttle = $this->rateLimiter->consume('stock_alert', 'customer:' . $customerId, 10, 3600);
        if (!$throttle['allowed']) {
            return ['status' => 'rate_limited', 'retry_after' => $throttle['retry_after'], 'message' => __('Please wait before creating another product alert.')->render()];
        }

        $alert = $this->stockFactory->create();
        $alert->setCustomerId($customerId)
            ->setProductId((int)$product->getId())
            ->setWebsiteId($websiteId)
            ->setAddDate(gmdate('Y-m-d H:i:s'))
            ->setStatus(0);
        $this->stockAlertResource->save($alert);

        return ['status' => 'success', 'sku' => (string)$product->getSku(), 'product_name' => (string)$product->getName(), 'message' => __('We will email you when this product is back in stock.')->render()];
    }

    private function getVisibleProduct(string $sku, ShopperScope $scope): ?object
    {
        if ($sku === '') {
            return null;
        }

        $collection = $this->productCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToProductCollection($collection, $scope);
        $collection->addAttributeToSelect(['sku', 'name'])
            ->addAttributeToFilter('sku', ['eq' => $sku])
            ->setPageSize(1);
        $product = $collection->getFirstItem();

        return (int)$product->getId() > 0 ? $product : null;
    }
}
