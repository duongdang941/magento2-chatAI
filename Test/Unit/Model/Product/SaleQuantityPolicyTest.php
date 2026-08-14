<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Product;

use Afd\AI\Model\Product\SaleQuantityPolicy;
use Magento\CatalogInventory\Api\Data\StockItemInterface;
use Magento\CatalogInventory\Api\StockRegistryInterface;
use Magento\Framework\DataObject;
use PHPUnit\Framework\TestCase;

class SaleQuantityPolicyTest extends TestCase
{
    public function testUsesFirstIncrementAsDefaultWhenConfiguredMinimumIsLower(): void
    {
        $stockItem = $this->createMock(StockItemInterface::class);
        $stockItem->method('getIsQtyDecimal')->willReturn(false);
        $stockItem->method('getMinSaleQty')->willReturn(1.0);
        $stockItem->method('getEnableQtyIncrements')->willReturn(true);
        $stockItem->method('getQtyIncrements')->willReturn(50.0);
        $stockItem->method('getMaxSaleQty')->willReturn(100000.0);

        $stockRegistry = $this->createMock(StockRegistryInterface::class);
        $stockRegistry->expects(self::once())
            ->method('getStockItem')
            ->with(2215)
            ->willReturn($stockItem);

        $policy = new SaleQuantityPolicy($stockRegistry);
        $product = new DataObject(['id' => 2215]);

        self::assertSame([
            'minimum_qty' => 50,
            'maximum_qty' => 100000,
            'qty_increment' => 50,
            'default_add_qty' => 50,
            'is_qty_decimal' => false,
            'resolved' => true,
        ], $policy->getPolicy($product));
        self::assertFalse($policy->validate($product, 1)['valid']);
        self::assertTrue($policy->validate($product, 50)['valid']);
        self::assertFalse($policy->validate($product, 51)['valid']);
        self::assertTrue($policy->validate($product, 100)['valid']);
    }
}
