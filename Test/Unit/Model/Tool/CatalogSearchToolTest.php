<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Tool;

use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Model\Catalog\PriceConstraintConverter;
use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Data\ToolResponseFactory;
use Afd\AI\Model\Product\CatalogIdentityMatcher;
use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Afd\AI\Model\Tool\CatalogSearchTool;
use Afd\AI\Model\Tool\FulltextProductCollectionFactory;
use Magento\Catalog\Model\ResourceModel\Category\CollectionFactory as CategoryCollectionFactory;
use Magento\Catalog\Model\ResourceModel\Product\Collection;
use Magento\Catalog\Model\ResourceModel\Product\CollectionFactory as ProductCollectionFactory;
use Magento\CatalogInventory\Helper\Stock as StockHelper;
use Magento\Framework\Pricing\PriceCurrencyInterface;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

class CatalogSearchToolTest extends TestCase
{
    public function testVerifiedExactSkuUsesDirectCollectionAndRetainsShopperFilters(): void
    {
        $collection = $this->createMock(Collection::class);
        $filters = [];
        $collection->method('addAttributeToSelect')->willReturnSelf();
        $collection->method('addUrlRewrite')->willReturnSelf();
        $collection->method('addAttributeToFilter')->willReturnCallback(
            static function (string $attribute, array $condition) use (&$filters, $collection): Collection {
                $filters[] = [$attribute, $condition];

                return $collection;
            }
        );

        $productCollectionFactory = $this->createMock(ProductCollectionFactory::class);
        $productCollectionFactory->expects(self::once())
            ->method('create')
            ->willReturn($collection);

        $fulltextCollectionFactory = $this->createMock(FulltextProductCollectionFactory::class);
        $fulltextCollectionFactory->expects(self::never())->method('create');

        $stockHelper = $this->createMock(StockHelper::class);
        $stockHelper->expects(self::once())
            ->method('addInStockFilterToCollection')
            ->with($collection);

        $catalogVisibilityPolicy = $this->createMock(CatalogVisibilityPolicyInterface::class);
        $catalogVisibilityPolicy->expects(self::once())
            ->method('applyToProductCollection')
            ->with($collection, self::isInstanceOf(ShopperScope::class));

        $tool = $this->createTool(
            $fulltextCollectionFactory,
            $productCollectionFactory,
            $stockHelper,
            $catalogVisibilityPolicy
        );
        $method = new ReflectionMethod(CatalogSearchTool::class, 'createFilteredProductCollection');
        $scope = new ShopperScope(1, 'default', 1, 0);

        $result = $method->invoke(
            $tool,
            'SKU-42',
            [],
            0.0,
            0.0,
            false,
            [],
            '',
            [],
            [],
            true,
            $scope
        );

        self::assertSame($collection, $result);
        self::assertContains(['sku', ['eq' => 'SKU-42']], $filters);
    }

    public function testExactSkuMissCannotEnterIdentityFallback(): void
    {
        $tool = (new \ReflectionClass(CatalogSearchTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(CatalogSearchTool::class, 'shouldAttemptIdentityFallback');

        self::assertFalse($method->invoke($tool, 'SKU-42', true, true));
    }

    public function testStorefrontVisibilityIsTheOnlyProductEligibilityFilter(): void
    {
        $collection = $this->createMock(Collection::class);
        $attributeFilters = [];
        $collection->method('addAttributeToSelect')->willReturnSelf();
        $collection->method('addUrlRewrite')->willReturnSelf();
        $collection->method('addAttributeToFilter')->willReturnCallback(
            static function (string $attribute, array $condition) use (&$attributeFilters, $collection): Collection {
                $attributeFilters[] = [$attribute, $condition];

                return $collection;
            }
        );
        $collection->expects(self::never())->method('addFieldToFilter');

        $catalogVisibilityPolicy = $this->createMock(CatalogVisibilityPolicyInterface::class);
        $catalogVisibilityPolicy->expects(self::once())
            ->method('applyToProductCollection')
            ->with($collection, self::isInstanceOf(ShopperScope::class));

        $tool = $this->createTool(
            $this->createMock(FulltextProductCollectionFactory::class),
            $this->createMock(ProductCollectionFactory::class),
            $this->createMock(StockHelper::class),
            $catalogVisibilityPolicy
        );
        $scope = new ShopperScope(1, 'default', 1, 0);
        $method = new ReflectionMethod(CatalogSearchTool::class, 'configureProductCollection');
        $method->invoke($tool, $collection, $scope);

        self::assertNotContains(['type_id', ['in' => ['simple', 'configurable']]], $attributeFilters);
        self::assertNotContains(['name', ['nlike' => '%Demo Produkt%']], $attributeFilters);
        self::assertNotContains(['url_key', ['nlike' => 'demo%']], $attributeFilters);
    }

    private function createTool(
        FulltextProductCollectionFactory $fulltextCollectionFactory,
        ProductCollectionFactory $productCollectionFactory,
        StockHelper $stockHelper,
        CatalogVisibilityPolicyInterface $catalogVisibilityPolicy
    ): CatalogSearchTool {
        return new CatalogSearchTool(
            $this->createMock(PriceCurrencyInterface::class),
            $this->createMock(ProductRendererInterface::class),
            $this->createMock(ToolResponseFactory::class),
            $fulltextCollectionFactory,
            $productCollectionFactory,
            $this->createMock(CategoryCollectionFactory::class),
            $stockHelper,
            $this->createMock(DirectAddEligibility::class),
            $this->createMock(SaleQuantityPolicy::class),
            $this->createMock(CatalogIdentityMatcher::class),
            $this->createMock(ShopperScopeResolver::class),
            $catalogVisibilityPolicy,
            $this->createMock(PriceConstraintConverter::class)
        );
    }
}
