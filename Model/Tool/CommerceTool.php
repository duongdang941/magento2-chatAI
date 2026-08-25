<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Data\ToolResponseFactory;
use Magento\Catalog\Model\ResourceModel\Product\CollectionFactory as ProductCollectionFactory;
use Magento\Catalog\Pricing\Price\FinalPrice;
use Magento\Framework\Pricing\PriceCurrencyInterface;
use Magento\SalesRule\Model\ResourceModel\Rule\CollectionFactory as RuleCollectionFactory;
use Psr\Log\LoggerInterface;

/** Groups read-only comparison and promotion queries. */
class CommerceTool
{
    public function __construct(
        private readonly PriceCurrencyInterface $priceCurrency,
        private readonly ProductCollectionFactory $productCollectionFactory,
        private readonly RuleCollectionFactory $ruleCollectionFactory,
        private readonly ToolResponseFactory $toolResponseFactory,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly CatalogVisibilityPolicyInterface $catalogVisibilityPolicy,
        private readonly LoggerInterface $logger,
        private readonly AiConfig $aiConfig
    ) {
    }


    /**
     * @inheritDoc
     */
    public function compareProducts(
        string $sku1,
        string $sku2,
        int $customerGroupId = 0,
        int $customerId = 0
    )
    {
        try {
            $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
            $skus = [$sku1, $sku2];
            $products = [];
            $missingSkus = [];
            foreach ($skus as $sku) {
                try {
                    $product = $this->getScopedProduct($sku, $shopperScope);
                    if (!$product) {
                        $missingSkus[] = trim($sku);
                        continue;
                    }
                    $product->setCustomerGroupId($shopperScope->getCustomerGroupId());
                    $products[] = [
                        'name' => $product->getName(),
                        'sku' => $product->getSku(),
                        'price' => $this->priceCurrency->format($this->getDisplayFinalPrice($product), false),
                        'description' => strip_tags((string)$product->getShortDescription()),
                        'weight' => $product->getWeight(),
                        'url' => $product->getProductUrl()
                    ];
                } catch (\Magento\Framework\Exception\NoSuchEntityException $e) {
                    $missingSkus[] = trim($sku);
                    continue;
                }
            }

            // A one-sided result must not present itself as a complete
            // comparison: the model needs to know which requested SKU could
            // not be resolved in the shopper's scope.
            if (empty($products)) {
                $result = [
                    'status' => 'NOT_FOUND',
                    'message' => __('No products found for comparison.'),
                    'missing_skus' => $missingSkus,
                ];
            } else {
                $result = ['status' => 'OK', 'products' => $products, 'missing_skus' => $missingSkus];
            }
        } catch (\Throwable $exception) {
            $this->logger->error('AI product comparison failed.', ['exception' => $exception]);
            $result = ['status' => 'ERROR', 'message' => __('Comparison is temporarily unavailable.')->render()];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }

    private function getScopedProduct(string $sku, ShopperScope $shopperScope)
    {
        $collection = $this->productCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToProductCollection($collection, $shopperScope);
        $collection->addAttributeToSelect(['name', 'sku', 'price', 'short_description', 'weight', 'url_key']);
        $collection->addAttributeToFilter('sku', ['eq' => trim($sku)]);
        $collection->addUrlRewrite();
        $collection->setPageSize(1);

        $product = $collection->getFirstItem();

        return (int)$product->getId() > 0 ? $product : null;
    }

    private function getDisplayFinalPrice($product): float
    {
        $price = $product->getPriceInfo()->getPrice(FinalPrice::PRICE_CODE)->getValue();
        if (is_numeric($price)) {
            return (float)$price;
        }

        $indexedPrice = $product->getData('final_price');

        return is_numeric($indexedPrice)
            ? (float)$indexedPrice
            : (float)$product->getFinalPrice();
    }

    /**
     * @inheritDoc
     */
    public function getActiveCoupons(int $customerGroupId = 0, int $customerId = 0)
    {
        try {
            $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
            $collection = $this->ruleCollectionFactory->create();
            $collection->addAllowedSalesRulesFilter();
            $collection->addWebsiteFilter($shopperScope->getWebsiteId());
            $collection->addCustomerGroupFilter($shopperScope->getCustomerGroupId());
            $collection->addFieldToFilter('is_active', ['eq' => 1]);
            $collection->addFieldToFilter('coupon_type', [
                'in' => [
                    \Magento\SalesRule\Model\Rule::COUPON_TYPE_SPECIFIC,
                    \Magento\SalesRule\Model\Rule::COUPON_TYPE_NO_COUPON
                ]
            ]);

            $coupons = [];
            foreach ($collection as $rule) {
                // Focus on rules with actual coupon codes or simple auto-applied rules
                $coupons[] = [
                    'name' => $rule->getName(),
                    'code' => $this->publicCouponCode($rule, $shopperScope),
                    'description' => $rule->getDescription(),
                    'from_date' => $rule->getFromDate(),
                    'to_date' => $rule->getToDate()
                ];
            }

            $result = [
                'status' => 'OK',
                'coupons' => $coupons,
                'message' => __('Found %1 active promotions.', count($coupons))->render()
            ];
        } catch (\Throwable $exception) {
            $this->logger->error('AI coupon lookup failed.', ['exception' => $exception]);
            $result = ['status' => 'ERROR', 'message' => __('Promotions are temporarily unavailable.')->render()];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }

    private function publicCouponCode($rule, ShopperScope $shopperScope): string
    {
        if (!$rule->getPrimaryCoupon()) {
            return __('Auto-applied')->render();
        }

        if (!$this->aiConfig->canExposeCouponCodes($shopperScope->getStoreId())) {
            return __('Ask the store team for eligibility')->render();
        }

        return (string)$rule->getPrimaryCoupon()->getCode();
    }
}
