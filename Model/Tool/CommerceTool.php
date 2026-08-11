<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Model\Data\ToolResponseFactory;
use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Framework\Pricing\PriceCurrencyInterface;
use Magento\SalesRule\Model\ResourceModel\Rule\CollectionFactory as RuleCollectionFactory;

/** Groups read-only comparison and promotion queries. */
class CommerceTool
{
    private PriceCurrencyInterface $priceCurrency;
    private ProductRepositoryInterface $productRepository;
    private RuleCollectionFactory $ruleCollectionFactory;
    private ToolResponseFactory $toolResponseFactory;

    public function __construct(
        PriceCurrencyInterface $priceCurrency,
        ProductRepositoryInterface $productRepository,
        RuleCollectionFactory $ruleCollectionFactory,
        ToolResponseFactory $toolResponseFactory
    ) {
        $this->priceCurrency = $priceCurrency;
        $this->productRepository = $productRepository;
        $this->ruleCollectionFactory = $ruleCollectionFactory;
        $this->toolResponseFactory = $toolResponseFactory;
    }


    /**
     * @inheritDoc
     */
    public function compareProducts(string $sku1, string $sku2)
    {
        try {
            $skus = [$sku1, $sku2];
            $products = [];
            foreach ($skus as $sku) {
                try {
                    /** @var \Magento\Catalog\Model\Product $product */
                    $product = $this->productRepository->get($sku);
                    $products[] = [
                        'name' => $product->getName(),
                        'sku' => $product->getSku(),
                        'price' => $this->priceCurrency->format((float)$product->getFinalPrice(), false),
                        'description' => strip_tags((string)$product->getShortDescription()),
                        'weight' => $product->getWeight(),
                        'url' => $product->getProductUrl()
                    ];
                } catch (\Magento\Framework\Exception\NoSuchEntityException $e) {
                    continue;
                }
            }

            if (empty($products)) {
                $result = ['status' => 'NOT_FOUND', 'message' => __('No products found for comparison.')];
            } else {
                $result = ['status' => 'OK', 'products' => $products];
            }
        } catch (\Exception $e) {
            $result = ['status' => 'ERROR', 'message' => $e->getMessage()];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }

    /**
     * @inheritDoc
     */
    public function getActiveCoupons()
    {
        try {
            $collection = $this->ruleCollectionFactory->create();
            $collection->addAllowedSalesRulesFilter();
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
                    'code' => $rule->getPrimaryCoupon() ? $rule->getPrimaryCoupon()->getCode() : __('Auto-applied'),
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
        } catch (\Exception $e) {
            $result = ['status' => 'ERROR', 'message' => $e->getMessage()];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }
}
