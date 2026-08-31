<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Tool;

use Afd\AI\Model\Tool\ProductAvailabilityTool;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

class ProductAvailabilityToolTest extends TestCase
{
    /**
     * @dataProvider shortLabelMatchingDataProvider
     */
    public function testShortLabelsOnlyMatchExactly(string $actual, string $requested, bool $expected): void
    {
        self::assertSame($expected, $this->labelsMatch($actual, $requested));
    }

    public static function shortLabelMatchingDataProvider(): array
    {
        return [
            's must not match xs' => ['xs', 's', false],
            's matches s' => ['s', 's', true],
            'm must not match medium' => ['medium', 'm', false],
            'm matches m' => ['m', ' m ', true],
            'matching is case insensitive' => ['XS', 'xs', true],
        ];
    }

    public function testLongerRequestedLabelMatchesOnWordBoundaryOnly(): void
    {
        self::assertTrue($this->labelsMatch('dark red', 'red'));
        self::assertTrue($this->labelsMatch('dark-red', 'red'));
        self::assertFalse($this->labelsMatch('bordered', 'red'));
        self::assertFalse($this->labelsMatch('border', 'bor'));
    }

    public function testEmptyLabelsNeverMatch(): void
    {
        self::assertFalse($this->labelsMatch('', 's'));
        self::assertFalse($this->labelsMatch('s', ''));
        self::assertFalse($this->labelsMatch('  ', 's'));
    }

    public function testMultiVariantAvailabilityDoesNotExposeChildQuantities(): void
    {
        $variants = $this->variantsForResponse([
            ['sku' => 'PARENT-S', 'availability' => 'in_stock', 'salable_qty' => 12],
            ['sku' => 'PARENT-M', 'availability' => 'low_stock', 'salable_qty' => 2],
        ], false);

        self::assertSame([
            ['sku' => 'PARENT-S', 'availability' => 'in_stock'],
            ['sku' => 'PARENT-M', 'availability' => 'low_stock'],
        ], $variants);
    }

    public function testExactlyMatchedVariantKeepsItsAuthoritativeQuantity(): void
    {
        $variants = $this->variantsForResponse([
            ['sku' => 'PARENT-M', 'availability' => 'in_stock', 'salable_qty' => 12],
        ], true);

        self::assertSame(12, $variants[0]['salable_qty']);
    }

    public function testPartialConfigurableSelectionCannotIdentifyOnePurchasableVariant(): void
    {
        $tool = (new ReflectionClass(ProductAvailabilityTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ProductAvailabilityTool::class, 'missingConfigurableOptionCodes');

        self::assertSame(
            ['bedruckung', 'logoauswahl', 'gender'],
            $method->invoke($tool, ['bedruckung', 'logoauswahl', 'grosse', 'gender'], ['grosse' => 'S'])
        );
        self::assertSame(
            [],
            $method->invoke(
                $tool,
                ['bedruckung', 'logoauswahl', 'grosse', 'gender'],
                [
                    'bedruckung' => 'Brustdruck',
                    'logoauswahl' => 'Standard-Logo',
                    'grosse' => 'S',
                    'gender' => 'Damen',
                ]
            )
        );
    }

    private function labelsMatch(string $actual, string $requested): bool
    {
        // labelsMatch is a pure helper; building it without the constructor
        // keeps MSI and store dependencies out of this unit test.
        $tool = (new ReflectionClass(ProductAvailabilityTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ProductAvailabilityTool::class, 'labelsMatch');

        return $method->invoke($tool, $actual, $requested);
    }

    /** @param array<int, array<string, mixed>> $variants */
    private function variantsForResponse(array $variants, bool $exposesExactVariantQuantity): array
    {
        $tool = (new ReflectionClass(ProductAvailabilityTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ProductAvailabilityTool::class, 'variantsForResponse');

        return $method->invoke($tool, $variants, $exposesExactVariantQuantity);
    }
}
