<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Catalog;

use Afd\AI\Model\Catalog\CatalogVisibilityPolicy;
use Afd\AI\Model\Catalog\ShopperScope;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Module\Manager as ModuleManager;
use PHPUnit\Framework\TestCase;

class CatalogVisibilityPolicyTest extends TestCase
{
    public function testAddsAnExplicitVisibilityConstraintForFulltextCollections(): void
    {
        $moduleManager = $this->createMock(ModuleManager::class);
        $moduleManager->expects(self::once())
            ->method('isEnabled')
            ->with('Aheadworks_CustGroupCatPermissions')
            ->willReturn(false);

        $policy = new CatalogVisibilityPolicy(
            $moduleManager,
            $this->createMock(ResourceConnection::class),
            $this->createMock(ScopeConfigInterface::class)
        );
        $collection = new class {
            /** @var array<string, mixed> */
            public array $calls = [];

            public function setStoreId(int $storeId): self
            {
                $this->calls['store_id'] = $storeId;
                return $this;
            }

            public function addStoreFilter(int $storeId): self
            {
                $this->calls['store_filter'] = $storeId;
                return $this;
            }

            /** @param int[] $websiteIds */
            public function addWebsiteFilter(array $websiteIds): self
            {
                $this->calls['website_filter'] = $websiteIds;
                return $this;
            }

            /** @param int[] $visibility */
            public function setVisibility(array $visibility): self
            {
                $this->calls['visibility'] = $visibility;
                return $this;
            }

            /** @param array<string, int[]> $condition */
            public function addAttributeToFilter(string $attribute, array $condition): self
            {
                $this->calls['attribute_filters'][] = [$attribute, $condition];
                return $this;
            }

            public function addPriceData(int $customerGroupId, int $websiteId): self
            {
                $this->calls['price_data'] = [$customerGroupId, $websiteId];
                return $this;
            }
        };

        $policy->applyToProductCollection($collection, new ShopperScope(4, 'store', 7, 3));

        self::assertSame([2, 3, 4], $collection->calls['visibility']);
        self::assertContains(
            ['visibility', ['in' => [2, 3, 4]]],
            $collection->calls['attribute_filters']
        );
    }
}
