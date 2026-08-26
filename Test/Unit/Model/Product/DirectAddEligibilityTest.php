<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Product;

use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Catalog\Model\Product;
use PHPUnit\Framework\TestCase;

class DirectAddEligibilityTest extends TestCase
{
    public function testConfigurableSearchResultIsNotReloadedForDirectAddValidation(): void
    {
        $product = $this->createMock(Product::class);
        $product->method('getId')->willReturn(43);
        $product->expects(self::once())
            ->method('getData')
            ->with('type_id')
            ->willReturn('configurable');

        $productRepository = $this->createMock(ProductRepositoryInterface::class);
        $productRepository->expects(self::never())->method('getById');

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->expects(self::never())->method('getPolicy');

        $eligibility = new DirectAddEligibility($productRepository, $saleQuantityPolicy);

        self::assertFalse($eligibility->canAddToCartDirectly($product));
    }

    public function testSimpleProductWithAnOptionalCustomerOptionIsNotDirectlyAddable(): void
    {
        $inputProduct = $this->createMock(Product::class);
        $inputProduct->method('getId')->willReturn(42);

        $loadedProduct = $this->createMock(Product::class);
        $loadedProduct->method('getTypeId')->willReturn('simple');
        $loadedProduct->method('isSaleable')->willReturn(true);
        $loadedProduct->method('getData')->with('has_options')->willReturn(1);

        $productRepository = $this->createMock(ProductRepositoryInterface::class);
        $productRepository->expects(self::once())
            ->method('getById')
            ->with(42, false, null, true)
            ->willReturn($loadedProduct);

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->expects(self::never())->method('getPolicy');

        $eligibility = new DirectAddEligibility($productRepository, $saleQuantityPolicy);

        self::assertFalse($eligibility->canAddToCartDirectly($inputProduct));
    }
}
