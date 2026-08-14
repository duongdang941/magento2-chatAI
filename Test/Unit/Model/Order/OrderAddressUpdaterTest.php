<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Order;

use Afd\AI\Model\Order\OrderAddressFormMetadata;
use Afd\AI\Model\Order\OrderAddressUpdater;
use Magento\Directory\Model\AllowedCountries;
use Magento\Directory\Model\Country;
use Magento\Directory\Model\CountryFactory;
use Magento\Directory\Model\RegionFactory;
use Magento\Framework\Exception\LocalizedException;
use Magento\Sales\Model\Order;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

if (!class_exists(\Magento\Directory\Model\CountryFactory::class)) {
    class CountryFactoryStub
    {
        public function create(): \Magento\Directory\Model\Country
        {
            throw new \BadMethodCallException();
        }
    }
    class_alias(CountryFactoryStub::class, \Magento\Directory\Model\CountryFactory::class);
}

if (!class_exists(\Magento\Directory\Model\RegionFactory::class)) {
    class RegionFactoryStub
    {
        public function create(): \Magento\Directory\Model\Region
        {
            throw new \BadMethodCallException();
        }
    }
    class_alias(RegionFactoryStub::class, \Magento\Directory\Model\RegionFactory::class);
}

class OrderAddressUpdaterTest extends TestCase
{
    public function testEligibilityRejectsShippedOrder(): void
    {
        $order = $this->getMockBuilder(Order::class)->disableOriginalConstructor()->onlyMethods(['hasShipments'])->getMock();
        $order->method('hasShipments')->willReturn(true);

        $result = $this->createUpdater()->eligibility($order);

        self::assertFalse($result['allowed']);
        self::assertSame('order_already_shipped', $result['reason']);
    }

    public function testApplyNormalizesAndUpdatesEditableAddressFields(): void
    {
        $metadata = $this->getMockBuilder(OrderAddressFormMetadata::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['filterEditableChanges', 'requiredCodes', 'isZipRequired', 'isRegionRequired'])
            ->getMock();
        $changes = [
            'firstname' => '  Max   Mustermann ',
            'lastname' => 'Muster',
            'street' => [" Hauptstrasse   1 ", ''],
            'city' => ' Berlin ',
            'postcode' => '10115',
            'telephone' => ' 030  123 ',
            'country_id' => 'de',
        ];
        $metadata->method('filterEditableChanges')->willReturn($changes);
        $metadata->method('requiredCodes')->willReturn(['firstname', 'lastname', 'street', 'city', 'postcode', 'telephone', 'country_id']);
        $metadata->method('isZipRequired')->willReturn(true);
        $metadata->method('isRegionRequired')->willReturn(false);

        $address = new FakeOrderAddress();
        $address->data['city'] = 'Berlin';
        $address->data['postcode'] = '10115';
        $this->createUpdater($metadata)->apply($address, $changes, 1);

        self::assertSame('Max Mustermann', $address->data['firstname']);
        self::assertSame(['Hauptstrasse 1'], $address->data['street']);
        self::assertSame('Berlin', $address->data['city']);
        self::assertSame('DE', $address->data['country_id']);
        self::assertSame('030 123', $address->data['telephone']);
    }

    public function testApplyRejectsDestinationChangesThatWouldRequireTotalRecalculation(): void
    {
        $metadata = $this->getMockBuilder(OrderAddressFormMetadata::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['filterEditableChanges', 'requiredCodes', 'isZipRequired', 'isRegionRequired'])
            ->getMock();
        $changes = [
            'street' => ['New street 9'],
            'city' => 'Hamburg',
            'postcode' => '10115',
            'country_id' => 'DE',
        ];
        $metadata->method('filterEditableChanges')->willReturn($changes);
        $metadata->method('requiredCodes')->willReturn([]);
        $metadata->method('isZipRequired')->willReturn(true);
        $metadata->method('isRegionRequired')->willReturn(false);

        $address = new FakeOrderAddress();
        $address->data['city'] = 'Berlin';
        $address->data['postcode'] = '10115';

        $this->expectException(LocalizedException::class);
        $this->expectExceptionMessage('may change tax or shipping charges');

        $this->createUpdater($metadata)->apply($address, $changes, 1);
    }

    private function createUpdater(?OrderAddressFormMetadata $metadata = null): OrderAddressUpdater
    {
        $country = $this->getMockBuilder(Country::class)->disableOriginalConstructor()->onlyMethods(['loadByCode'])->getMock();
        $country->method('loadByCode')->willReturnSelf();
        $country->setId('DE');
        $countryFactory = $this->createMock(CountryFactory::class);
        $countryFactory->method('create')->willReturn($country);
        $regionFactory = $this->createMock(RegionFactory::class);
        $allowedCountries = $this->createMock(AllowedCountries::class);
        $allowedCountries->method('getAllowedCountries')->willReturn(['DE']);
        $store = $this->createMock(StoreInterface::class);
        $store->method('getWebsiteId')->willReturn(1);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);
        $metadata ??= $this->getMockBuilder(OrderAddressFormMetadata::class)->disableOriginalConstructor()->getMock();

        return new OrderAddressUpdater(
            $countryFactory,
            $regionFactory,
            $allowedCountries,
            $storeManager,
            $metadata
        );
    }
}
