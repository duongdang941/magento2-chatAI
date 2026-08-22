<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Catalog;

use Afd\AI\Model\Catalog\PriceConstraintConverter;
use Magento\Directory\Model\Currency;
use Magento\Directory\Model\CurrencyFactory;
use Magento\Store\Model\Store;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

class PriceConstraintConverterTest extends TestCase
{
    public function testConvertsExplicitUsdConstraintToStoreBaseCurrency(): void
    {
        $currency = $this->createMock(Currency::class);
        $currency->expects(self::once())->method('load')->with('USD')->willReturnSelf();
        $currency->expects(self::once())->method('getRate')->with('EUR')->willReturn(0.7067);
        $converter = new PriceConstraintConverter(
            $this->storeManager('EUR', 'EUR'),
            $this->currencyFactory($currency)
        );

        $result = $converter->convert(100.0, 0.0, 'usd');

        self::assertTrue($result['available']);
        self::assertSame(70.67, $result['min_price']);
        self::assertSame('USD', $result['meta']['requested_currency']);
        self::assertSame('EUR', $result['meta']['filter_currency']);
        self::assertSame(0.7067, $result['meta']['conversion_rate']);
    }

    public function testDoesNotSilentlyTreatMissingRateAsStoreCurrency(): void
    {
        $currency = $this->createMock(Currency::class);
        $currency->method('load')->willReturnSelf();
        $currency->method('getRate')->willReturn(false);
        $converter = new PriceConstraintConverter(
            $this->storeManager('EUR', 'EUR'),
            $this->currencyFactory($currency)
        );

        $result = $converter->convert(100.0, 0.0, 'USD');

        self::assertFalse($result['available']);
        self::assertTrue($result['meta']['currency_conversion_unavailable']);
        self::assertSame(100.0, $result['meta']['requested_min_price']);
    }

    public function testUsesCurrentStoreCurrencyWhenTheShopperDidNotNameOne(): void
    {
        $currency = $this->createMock(Currency::class);
        $currency->expects(self::once())->method('load')->with('USD')->willReturnSelf();
        $currency->expects(self::once())->method('getRate')->with('EUR')->willReturn(0.7);
        $converter = new PriceConstraintConverter(
            $this->storeManager('EUR', 'USD'),
            $this->currencyFactory($currency)
        );

        $result = $converter->convert(100.0, 0.0);

        self::assertTrue($result['available']);
        self::assertFalse($result['meta']['currency_explicit']);
        self::assertSame(70.0, $result['min_price']);
    }

    private function storeManager(string $baseCurrency, string $currentCurrency): StoreManagerInterface
    {
        $store = $this->createMock(Store::class);
        $store->method('getBaseCurrencyCode')->willReturn($baseCurrency);
        $store->method('getCurrentCurrencyCode')->willReturn($currentCurrency);
        $manager = $this->createMock(StoreManagerInterface::class);
        $manager->method('getStore')->willReturn($store);
        return $manager;
    }

    private function currencyFactory(Currency $currency): CurrencyFactory
    {
        $factory = $this->createMock(CurrencyFactory::class);
        $factory->method('create')->willReturn($currency);
        return $factory;
    }
}
