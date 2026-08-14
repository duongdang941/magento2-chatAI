<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Support;

use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Afd\AI\Model\Order\GuestOrderVerification;
use Afd\AI\Model\Security\ActionRateLimiter;
use Afd\AI\Model\Support\SupportCaseNotifier;
use Afd\AI\Model\Support\SupportCaseService;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Customer\Api\Data\CustomerInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\DB\Select;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Math\Random;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

class SupportCaseServiceTest extends TestCase
{
    public function testLoggedInCustomerListsSupportCasesWithoutGuestOtp(): void
    {
        $customer = $this->createMock(CustomerInterface::class);
        $customer->method('getEmail')->willReturn('account@example.com');
        $customerRepository = $this->createMock(CustomerRepositoryInterface::class);
        $customerRepository->expects(self::once())->method('getById')->with(42)->willReturn($customer);

        $guestVerification = $this->createMock(GuestOrderVerification::class);
        $guestVerification->expects(self::never())->method('hasAccess');

        $select = $this->createMock(Select::class);
        $select->method('from')->willReturnSelf();
        $select->method('joinInner')->willReturnSelf();
        $select->method('where')->willReturnSelf();
        $select->method('order')->willReturnSelf();
        $select->method('limit')->willReturnSelf();
        $connection = $this->createMock(AdapterInterface::class);
        $connection->method('select')->willReturn($select);
        $connection->method('fetchAll')->willReturn([]);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnCallback(static fn (string $name): string => $name);

        $store = $this->createMock(StoreInterface::class);
        $store->method('getId')->willReturn(3);
        $store->method('getWebsiteId')->willReturn(2);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);

        $service = new SupportCaseService(
            $resource,
            $this->createMock(ScopeConfigInterface::class),
            $storeManager,
            $guestVerification,
            $this->createMock(ActionRateLimiter::class),
            $this->createMock(EncryptorInterface::class),
            $this->createMock(Random::class),
            $this->createMock(SupportCaseNotifier::class),
            $this->createMock(SupportMessagePublisher::class),
            $customerRepository
        );

        $result = $service->listVerified(42, null, 'untrusted@example.com', '', '');

        self::assertSame('success', $result['status']);
        self::assertSame([], $result['cases']);
    }
}
