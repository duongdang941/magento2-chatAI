<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Cart;

use Afd\AI\Model\Cart\OptionalQuoteCartAdapter;
use Magento\Framework\ObjectManagerInterface;
use PHPUnit\Framework\TestCase;

class OptionalQuoteCartAdapterTest extends TestCase
{
    public function testAbsentExtensionDoesNotBreakDependencyInjection(): void
    {
        $objectManager = $this->createMock(ObjectManagerInterface::class);
        $objectManager->expects(self::never())->method('get');
        $adapter = new OptionalQuoteCartAdapter($objectManager, 'Missing\Quote\Cart');

        self::assertFalse($adapter->isAvailable());
        self::assertNull($adapter->getCart());
    }
}
