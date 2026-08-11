<?php
declare(strict_types=1);

namespace Afd\AI\Model\Product;

use Magento\CatalogInventory\Api\StockRegistryInterface;

/**
 * Reads Magento's cart quantity rules for a product.
 *
 * Quantity increments are purchase constraints, not product options. Keeping
 * them in one service prevents catalogue cards, the AI tool and checkout from
 * making different promises for the same product.
 */
class SaleQuantityPolicy
{
    /** @var array<int, array<string, int|float|bool|null>> */
    private array $policyByProductId = [];

    public function __construct(
        private readonly StockRegistryInterface $stockRegistry
    ) {
    }

    /**
     * @return array{
     *     minimum_qty: int|float,
     *     maximum_qty: int|float|null,
     *     qty_increment: int|float,
     *     default_add_qty: int|float|null,
     *     is_qty_decimal: bool,
     *     resolved: bool
     * }
     */
    public function getPolicy($product): array
    {
        $productId = (int)($product?->getId() ?? 0);
        if ($productId < 1) {
            return $this->fallbackPolicy();
        }

        if (isset($this->policyByProductId[$productId])) {
            return $this->policyByProductId[$productId];
        }

        try {
            $stockItem = $this->stockRegistry->getStockItem($productId);
            $isDecimal = (bool)$stockItem->getIsQtyDecimal();
            $configuredMinimum = max(0.0, (float)$stockItem->getMinSaleQty());
            $increment = (bool)$stockItem->getEnableQtyIncrements()
                ? max(0.0, (float)$stockItem->getQtyIncrements())
                : 0.0;

            // Magento requires an increment multiple even when min_sale_qty
            // itself is lower. The first actually purchasable quantity is the
            // value useful to shoppers and to a default Add to Cart action.
            $minimum = max($configuredMinimum, $increment, 1.0);
            if ($increment > 0.0) {
                $minimum = ceil($minimum / $increment) * $increment;
            }
            if (!$isDecimal) {
                $minimum = ceil($minimum);
                $increment = $increment > 0.0 ? ceil($increment) : 1.0;
            } elseif ($increment <= 0.0) {
                $increment = 1.0;
            }

            $configuredMaximum = (float)$stockItem->getMaxSaleQty();
            $maximum = $configuredMaximum > 0.0 ? $configuredMaximum : null;
            $default = $maximum !== null && $minimum > $maximum ? null : $minimum;

            return $this->policyByProductId[$productId] = [
                'minimum_qty' => $this->normalizeNumber($minimum),
                'maximum_qty' => $maximum === null ? null : $this->normalizeNumber($maximum),
                'qty_increment' => $this->normalizeNumber($increment),
                'default_add_qty' => $default === null ? null : $this->normalizeNumber($default),
                'is_qty_decimal' => $isDecimal,
                'resolved' => true,
            ];
        } catch (\Throwable) {
            return $this->policyByProductId[$productId] = $this->fallbackPolicy();
        }
    }

    /**
     * @return array<string, int|float|bool|null|string>
     */
    public function validate($product, float $qty): array
    {
        $policy = $this->getPolicy($product);
        $minimum = (float)$policy['minimum_qty'];
        $maximum = $policy['maximum_qty'] === null ? null : (float)$policy['maximum_qty'];
        $increment = (float)$policy['qty_increment'];
        $valid = $qty > 0.0
            && $qty + 0.000001 >= $minimum
            && ($maximum === null || $qty <= $maximum + 0.000001)
            && ($policy['is_qty_decimal'] || abs($qty - round($qty)) < 0.000001)
            && ($increment <= 0.0 || $this->isIncrementMultiple($qty, $increment));

        return [
            ...$policy,
            'valid' => $valid,
            'requested_qty' => $this->normalizeNumber($qty),
            'reason' => $valid ? '' : 'invalid_quantity',
        ];
    }

    /** @return array<string, int|float|bool|null> */
    private function fallbackPolicy(): array
    {
        return [
            'minimum_qty' => 1,
            'maximum_qty' => null,
            'qty_increment' => 1,
            'default_add_qty' => 1,
            'is_qty_decimal' => false,
            'resolved' => false,
        ];
    }

    private function isIncrementMultiple(float $qty, float $increment): bool
    {
        if ($increment <= 0.0) {
            return true;
        }

        $remainder = fmod($qty, $increment);
        return abs($remainder) < 0.000001 || abs($remainder - $increment) < 0.000001;
    }

    private function normalizeNumber(float $value): int|float
    {
        return abs($value - round($value)) < 0.000001 ? (int)round($value) : $value;
    }
}
