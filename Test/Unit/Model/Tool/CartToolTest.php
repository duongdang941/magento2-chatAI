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
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Phrase;
use Magento\Quote\Model\Quote;
use Magento\Quote\Model\Quote\Item;
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

    public function testUpdateCartItemRejectsZeroQuantityThroughTheSalePolicy(): void
    {
        $cartItem = $this->createConfiguredMock(Item::class, [
            'getSku' => 'SIMPLE-1',
            'getName' => 'Simple product',
        ]);
        $cartProduct = $this->createMock(Product::class);
        $cartProduct->method('getId')->willReturn(7);
        $cartProduct->method('getSku')->willReturn('SIMPLE-1');
        $cartItem->method('getProduct')->willReturn($cartProduct);

        $policy = [
            'minimum_qty' => 1,
            'maximum_qty' => null,
            'qty_increment' => 1,
            'default_add_qty' => 1,
            'is_qty_decimal' => false,
            'resolved' => true,
            'valid' => false,
            'requested_qty' => 0,
            'reason' => 'invalid_quantity',
        ];
        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->expects(self::once())
            ->method('validate')
            ->with(self::identicalTo($cartProduct), 0.0)
            ->willReturn($policy);

        $checkoutCart = $this->checkoutCartWithItems([$cartItem]);
        $checkoutCart->expects(self::never())->method('save');

        $tool = $this->cartTool($checkoutCart, $saleQuantityPolicy);
        $result = $tool->updateSelectedCartItemQuantity('SIMPLE-1', 0);

        self::assertSame('requires_customer_action', $result['status']);
        self::assertSame('invalid_quantity', $result['reason']);
        self::assertSame('Please choose a quantity allowed for this product.', $result['message']);
        self::assertSame('SIMPLE-1', $result['sku']);
        self::assertSame(0, $result['requested_qty']);
    }

    public function testUpdateCartItemReportsAMissingSkuWithoutMutatingTheCart(): void
    {
        $cartItem = $this->createConfiguredMock(Item::class, ['getSku' => 'OTHER-1']);
        $cartItem->method('getChildren')->willReturn([]);

        $checkoutCart = $this->checkoutCartWithItems([$cartItem]);
        $checkoutCart->expects(self::never())->method('save');

        $tool = $this->cartTool($checkoutCart);
        $result = $tool->updateSelectedCartItemQuantity('missing-sku', 2);

        self::assertSame('requires_customer_action', $result['status']);
        self::assertSame('product_not_found_in_cart', $result['reason']);
        self::assertSame('This product was not found in your cart.', $result['message']);
        self::assertSame('missing-sku', $result['sku']);
        self::assertSame('checkout', $result['cart_type']);
    }

    public function testUpdateCartItemMatchesChildSkusCaseInsensitivelyAndUpdatesTheLine(): void
    {
        // A configurable line carries the parent SKU while the shopper asks
        // with the child variant SKU. Matching must follow the same rule as
        // removeFromCart: case-insensitive across parent and child SKUs.
        $childItem = $this->createConfiguredMock(Item::class, ['getSku' => 'child-simple']);
        $childItem->method('getChildren')->willReturn([]);
        $cartItem = $this->createConfiguredMock(Item::class, [
            'getSku' => 'PARENT-CONFIG',
            'getName' => 'Configurable product',
        ]);
        $cartProduct = $this->createMock(Product::class);
        $cartProduct->method('getId')->willReturn(9);
        $cartProduct->method('getSku')->willReturn('PARENT-CONFIG');
        $cartItem->method('getProduct')->willReturn($cartProduct);
        $cartItem->method('getChildren')->willReturn([$childItem]);

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->expects(self::once())
            ->method('validate')
            ->with(self::anything(), 3.0)
            ->willReturn([
                'minimum_qty' => 1,
                'maximum_qty' => 10,
                'qty_increment' => 1,
                'default_add_qty' => 1,
                'is_qty_decimal' => false,
                'resolved' => true,
                'valid' => true,
                'requested_qty' => 3,
                'reason' => '',
            ]);

        $cartItem->expects(self::once())->method('setQty')->with(3);
        $cartItem->method('getQty')->willReturn(3.0);

        $checkoutCart = $this->checkoutCartWithItems([$cartItem]);
        $checkoutCart->expects(self::once())->method('save');

        $tool = $this->cartTool($checkoutCart, $saleQuantityPolicy);
        $result = $tool->updateSelectedCartItemQuantity('CHILD-SIMPLE', 3);

        self::assertSame('success', $result['status']);
        self::assertSame('CHILD-SIMPLE', $result['sku']);
        self::assertSame(3, $result['qty']);
        self::assertSame('Configurable product', $result['product']);
        self::assertSame(4.5, $result['cart_qty']);
        self::assertSame('checkout', $result['cart_type']);
        // Legacy fields from the previous OK envelope stay available.
        self::assertArrayHasKey('message', $result);
    }

    public function testUpdateCartItemSupportsTheRequestQuoteTarget(): void
    {
        $cartItem = $this->createConfiguredMock(Item::class, [
            'getSku' => 'QUOTE-1',
            'getName' => 'Quote product',
            'getQty' => 2.0,
        ]);
        $cartItem->method('getChildren')->willReturn([]);
        $cartProduct = $this->createMock(Product::class);
        $cartProduct->method('getId')->willReturn(11);
        $cartProduct->method('getSku')->willReturn('QUOTE-1');
        $cartItem->method('getProduct')->willReturn($cartProduct);

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->method('validate')->willReturn([
            'minimum_qty' => 1,
            'maximum_qty' => null,
            'qty_increment' => 1,
            'default_add_qty' => 1,
            'is_qty_decimal' => false,
            'resolved' => true,
            'valid' => true,
            'requested_qty' => 2,
            'reason' => '',
        ]);

        $quoteCart = $this->checkoutCartWithItems([$cartItem], 6.0);
        $quoteCartAdapter = $this->createMock(QuoteCartAdapterInterface::class);
        $quoteCartAdapter->expects(self::once())->method('getCart')->willReturn($quoteCart);

        $tool = $this->cartTool(null, $saleQuantityPolicy, $quoteCartAdapter);
        $result = $tool->updateSelectedCartItemQuantity('QUOTE-1', 2, 'quote');

        self::assertSame('success', $result['status']);
        self::assertSame('request_quote', $result['cart_type']);
    }

    public function testUpdateCartItemReturnsAFixedErrorEnvelopeWhenTheCartFails(): void
    {
        $cartItem = $this->createConfiguredMock(Item::class, ['getSku' => 'FAIL-1', 'getName' => 'Failing product']);
        $cartItem->method('getChildren')->willReturn([]);
        $cartProduct = $this->createMock(Product::class);
        $cartProduct->method('getId')->willReturn(12);
        $cartProduct->method('getSku')->willReturn('FAIL-1');
        $cartItem->method('getProduct')->willReturn($cartProduct);

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->method('validate')->willReturn([
            'minimum_qty' => 1,
            'maximum_qty' => null,
            'qty_increment' => 1,
            'default_add_qty' => 1,
            'is_qty_decimal' => false,
            'resolved' => true,
            'valid' => true,
            'requested_qty' => 2,
            'reason' => '',
        ]);

        $checkoutCart = $this->checkoutCartWithItems([$cartItem]);
        $secretDetails = 'SQLSTATE[23000]: internal constraint detail';
        $checkoutCart->method('save')->willThrowException(new \RuntimeException($secretDetails));

        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects(self::once())->method('warning');

        $tool = $this->cartTool($checkoutCart, $saleQuantityPolicy, null, $logger);
        $result = $tool->updateSelectedCartItemQuantity('FAIL-1', 2);

        self::assertSame('error', $result['status']);
        self::assertSame('The selected product could not be updated in the cart.', $result['message']);
        self::assertStringNotContainsString($secretDetails, (string)$result['message']);
        self::assertSame('FAIL-1', $result['sku']);
    }

    public function testUpdateCartItemMapsInsufficientStockToAShopperAction(): void
    {
        $cartItem = $this->createConfiguredMock(Item::class, ['getSku' => 'STOCK-1', 'getName' => 'Stocked product']);
        $cartItem->method('getChildren')->willReturn([]);
        $cartProduct = $this->createMock(Product::class);
        $cartProduct->method('getId')->willReturn(13);
        $cartProduct->method('getSku')->willReturn('STOCK-1');
        $cartItem->method('getProduct')->willReturn($cartProduct);

        $saleQuantityPolicy = $this->createMock(SaleQuantityPolicy::class);
        $saleQuantityPolicy->method('validate')->willReturn([
            'minimum_qty' => 1,
            'maximum_qty' => null,
            'qty_increment' => 1,
            'default_add_qty' => 1,
            'is_qty_decimal' => false,
            'resolved' => true,
            'valid' => true,
            'requested_qty' => 99,
            'reason' => '',
        ]);

        $checkoutCart = $this->checkoutCartWithItems([$cartItem]);
        $checkoutCart->method('save')->willThrowException(
            new LocalizedException(new Phrase('The requested qty is not available.'))
        );

        $tool = $this->cartTool($checkoutCart, $saleQuantityPolicy);
        $result = $tool->updateSelectedCartItemQuantity('STOCK-1', 99);

        self::assertSame('requires_customer_action', $result['status']);
        self::assertSame('insufficient_stock', $result['reason']);
        self::assertSame('The requested quantity is not currently available.', $result['message']);
        self::assertSame(99, $result['requested_qty']);
    }

    private function cartTool(
        ?Cart $checkoutCart = null,
        ?SaleQuantityPolicy $saleQuantityPolicy = null,
        ?QuoteCartAdapterInterface $quoteCartAdapter = null,
        ?LoggerInterface $logger = null
    ): CartTool {
        return new CartTool(
            $checkoutCart ?? $this->createMock(Cart::class),
            $quoteCartAdapter ?? $this->createMock(QuoteCartAdapterInterface::class),
            $this->createMock(ProductRepositoryInterface::class),
            $this->createMock(DirectAddEligibility::class),
            $saleQuantityPolicy ?? $this->createMock(SaleQuantityPolicy::class),
            $this->createMock(ToolResponseFactory::class),
            $logger ?? $this->createMock(LoggerInterface::class)
        );
    }

    /**
     * @param array<int, Item> $items
     */
    private function checkoutCartWithItems(array $items, float $quoteQty = 4.5): Cart
    {
        $quote = $this->createMock(Quote::class);
        $quote->method('getAllVisibleItems')->willReturn($items);
        $quote->method('getItemsQty')->willReturn($quoteQty);

        $checkoutCart = $this->createMock(Cart::class);
        $checkoutCart->method('getQuote')->willReturn($quote);

        return $checkoutCart;
    }
}
