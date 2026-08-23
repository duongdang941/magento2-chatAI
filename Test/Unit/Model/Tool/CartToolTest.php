<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Tool;

use Afd\AI\Api\QuoteCartAdapterInterface;
use Afd\AI\Model\Data\ToolResponseFactory;
use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Afd\AI\Model\Tool\CartTool;
use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Catalog\Model\Product;
use Magento\Checkout\Model\Cart;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class CartToolTest extends TestCase
{
    public function testOptionedProductAlwaysReturnsItsProductPageBeforeCartMutation(): void
    {
        $product = $this->createMock(Product::class);
        $product->method('isSaleable')->willReturn(true);
        $product->method('getName')->willReturn('T-Shirt blau personalisierbar');
        $product->method('getSku')->willReturn('N022.A00');
        $product->method('getProductUrl')->willReturn('https://afd.test/t-shirt-hellblau-mit-wunsch-aufdruck-1-design.html');

        $productRepository = $this->createMock(ProductRepositoryInterface::class);
        $productRepository->expects(self::once())
            ->method('get')
            ->with('N022.A00')
            ->willReturn($product);

        $directAddEligibility = $this->createMock(DirectAddEligibility::class);
        $directAddEligibility->expects(self::once())
            ->method('canAddToCartDirectly')
            ->with($product)
            ->willReturn(false);

        $quoteCartAdapter = $this->createMock(QuoteCartAdapterInterface::class);
        $quoteCartAdapter->expects(self::never())->method('getCart');

        $tool = new CartTool(
            $this->createMock(Cart::class),
            $quoteCartAdapter,
            $productRepository,
            $directAddEligibility,
            $this->createMock(SaleQuantityPolicy::class),
            $this->createMock(ToolResponseFactory::class),
            $this->createMock(LoggerInterface::class)
        );

        $result = $tool->addSelectedProductToCart('N022.A00', 1, ['grosse' => 'L']);

        self::assertSame('requires_customer_action', $result['status']);
        self::assertSame('product_page_required', $result['reason']);
        self::assertSame('N022.A00', $result['sku']);
        self::assertSame('https://afd.test/t-shirt-hellblau-mit-wunsch-aufdruck-1-design.html', $result['url']);
    }
}
