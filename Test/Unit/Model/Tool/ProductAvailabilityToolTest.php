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

    private function labelsMatch(string $actual, string $requested): bool
    {
        // labelsMatch is a pure helper; building it without the constructor
        // keeps MSI and store dependencies out of this unit test.
        $tool = (new ReflectionClass(ProductAvailabilityTool::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ProductAvailabilityTool::class, 'labelsMatch');

        return $method->invoke($tool, $actual, $requested);
    }
}
