<?php
declare(strict_types=1);

namespace Afd\AI\Model\Catalog;

use Magento\Directory\Model\CurrencyFactory;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Converts shopper-facing catalogue price constraints to the base-currency
 * values used by Magento's price index.
 *
 * A model may identify that a shopper wrote "USD", but it must never invent a
 * rate. This service reads Magento's configured directory_currency_rate value
 * for the active store and makes an unavailable conversion explicit.
 */
class PriceConstraintConverter
{
    public function __construct(
        private readonly StoreManagerInterface $storeManager,
        private readonly CurrencyFactory $currencyFactory
    ) {
    }

    /**
     * @return array{available: bool, min_price: float, max_price: float, meta: array<string, mixed>}
     */
    public function convert(float $minPrice, float $maxPrice, string $requestedCurrency = ''): array
    {
        $store = $this->storeManager->getStore();
        $baseCurrency = strtoupper((string)$store->getBaseCurrencyCode());
        $storeCurrency = strtoupper((string)$store->getCurrentCurrencyCode());
        $explicitCurrency = strtoupper(trim($requestedCurrency));
        $sourceCurrency = $explicitCurrency !== '' ? $explicitCurrency : $storeCurrency;

        // A catalogue browse without a price constraint does not need a
        // currency rate. Avoid making category searches depend on an exchange
        // rate that is irrelevant to the request.
        if ($minPrice <= 0.0 && $maxPrice <= 0.0) {
            return [
                'available' => true,
                'min_price' => 0.0,
                'max_price' => 0.0,
                'meta' => [
                    'store_currency' => $storeCurrency,
                    'filter_currency' => $baseCurrency,
                    'requested_currency' => $sourceCurrency,
                    'currency_explicit' => $explicitCurrency !== '',
                    'conversion_rate' => 1.0,
                    'applied_min_price' => null,
                    'applied_max_price' => null,
                ],
            ];
        }

        if (!preg_match('/^[A-Z]{3}$/', $sourceCurrency) || $baseCurrency === '') {
            return $this->unavailable($minPrice, $maxPrice, $sourceCurrency, $storeCurrency, $baseCurrency);
        }

        $rate = 1.0;
        if ($sourceCurrency !== $baseCurrency) {
            try {
                $rate = (float)$this->currencyFactory->create()
                    ->load($sourceCurrency)
                    ->getRate($baseCurrency);
            } catch (\Throwable) {
                $rate = 0.0;
            }
        }

        if (!is_finite($rate) || $rate <= 0.0) {
            return $this->unavailable($minPrice, $maxPrice, $sourceCurrency, $storeCurrency, $baseCurrency);
        }

        return [
            'available' => true,
            'min_price' => $minPrice > 0 ? round($minPrice * $rate, 4) : 0.0,
            'max_price' => $maxPrice > 0 ? round($maxPrice * $rate, 4) : 0.0,
            'meta' => [
                'store_currency' => $storeCurrency,
                'filter_currency' => $baseCurrency,
                'requested_currency' => $sourceCurrency,
                'currency_explicit' => $explicitCurrency !== '',
                'conversion_rate' => $rate,
                'applied_min_price' => $minPrice > 0 ? round($minPrice * $rate, 4) : null,
                'applied_max_price' => $maxPrice > 0 ? round($maxPrice * $rate, 4) : null,
            ],
        ];
    }

    /** @return array{available: false, min_price: float, max_price: float, meta: array<string, mixed>} */
    private function unavailable(
        float $minPrice,
        float $maxPrice,
        string $requestedCurrency,
        string $storeCurrency,
        string $baseCurrency
    ): array {
        return [
            'available' => false,
            'min_price' => 0.0,
            'max_price' => 0.0,
            'meta' => [
                'store_currency' => $storeCurrency,
                'filter_currency' => $baseCurrency,
                'requested_currency' => $requestedCurrency,
                'currency_conversion_unavailable' => true,
                'requested_min_price' => $minPrice > 0 ? $minPrice : null,
                'requested_max_price' => $maxPrice > 0 ? $maxPrice : null,
            ],
        ];
    }
}
