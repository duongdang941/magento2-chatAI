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
use Magento\Framework\DB\Select;
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
            'standard',
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

    public function testNonExactSearchNarrowsOnlyOneUnambiguousIdentityCard(): void
    {
        $tool = $this->createTool(
            $this->createMock(FulltextProductCollectionFactory::class),
            $this->createMock(ProductCollectionFactory::class),
            $this->createMock(StockHelper::class),
            $this->createMock(CatalogVisibilityPolicyInterface::class),
            new CatalogIdentityMatcher()
        );
        $method = new ReflectionMethod(CatalogSearchTool::class, 'filterPresentedUniqueIdentityMatch');
        $products = [
            ['name' => 'Aufkleber "Moped"'],
            ['name' => 'Aufkleber "Autobahn"'],
            ['name' => 'Aufkleber "Verfassungsschutz"']
        ];

        self::assertSame([
            [['name' => 'Aufkleber "Verfassungsschutz"']],
            [503]
        ], $method->invoke($tool, 'Aufkleber Verfassungschuz', $products, [501, 502, 503]));
    }

    public function testNonExactSearchKeepsProductFamilyWhenClosestIdentityIsTied(): void
    {
        $tool = $this->createTool(
            $this->createMock(FulltextProductCollectionFactory::class),
            $this->createMock(ProductCollectionFactory::class),
            $this->createMock(StockHelper::class),
            $this->createMock(CatalogVisibilityPolicyInterface::class),
            new CatalogIdentityMatcher()
        );
        $method = new ReflectionMethod(CatalogSearchTool::class, 'filterPresentedUniqueIdentityMatch');
        $products = [
            ['name' => 'T-Shirt "AfD" schwarz'],
            ['name' => 'T-Shirt "AfD" weiß']
        ];

        self::assertNull($method->invoke($tool, 'T-Shirt AfD', $products, [501, 502]));
    }

    public function testRejectsAFallbackFulltextPageWithoutQueryEvidence(): void
    {
        $tool = $this->createTool(
            $this->createMock(FulltextProductCollectionFactory::class),
            $this->createMock(ProductCollectionFactory::class),
            $this->createMock(StockHelper::class),
            $this->createMock(CatalogVisibilityPolicyInterface::class),
            new CatalogIdentityMatcher()
        );
        $method = new ReflectionMethod(CatalogSearchTool::class, 'hasVerifiedQueryLexicalEvidence');

        self::assertFalse($method->invoke($tool, 'Kappe', [[
            'name' => 'Metall-Kugelschreiber "Mut zur Wahrheit"',
            'sku' => 'N021.A108',
        ]]));
        self::assertTrue($method->invoke($tool, 'Kappe', [[
            'name' => 'Kappe "AfD" schwarz',
            'sku' => 'N022.G004',
        ]]));
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

    public function testLowestPricePreferenceResetsDefaultOrderBeforeSortingByShopperPrice(): void
    {
        $select = $this->createMock(Select::class);
        $select->expects(self::once())
            ->method('reset')
            ->with(Select::ORDER)
            ->willReturnSelf();
        $select->expects(self::once())
            ->method('order')
            ->with('price_index.min_price ASC')
            ->willReturnSelf();

        $collection = $this->createMock(Collection::class);
        $collection->expects(self::once())
            ->method('getSelect')
            ->willReturn($select);

        $tool = (new \ReflectionClass(CatalogSearchTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(CatalogSearchTool::class, 'applyPricePreference');
        $method->invoke($tool, $collection, 'lowest');
    }

    public function testStandardPricePreferenceKeepsDefaultCollectionOrder(): void
    {
        $collection = $this->createMock(Collection::class);
        $collection->expects(self::never())->method('getSelect');

        $tool = (new \ReflectionClass(CatalogSearchTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(CatalogSearchTool::class, 'applyPricePreference');
        $method->invoke($tool, $collection, 'standard');
    }

    private function createTool(
        FulltextProductCollectionFactory $fulltextCollectionFactory,
        ProductCollectionFactory $productCollectionFactory,
        StockHelper $stockHelper,
        CatalogVisibilityPolicyInterface $catalogVisibilityPolicy,
        ?CatalogIdentityMatcher $catalogIdentityMatcher = null
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
            $catalogIdentityMatcher ?? $this->createMock(CatalogIdentityMatcher::class),
            $this->createMock(ShopperScopeResolver::class),
            $catalogVisibilityPolicy,
            $this->createMock(PriceConstraintConverter::class)
        );
    }
}
