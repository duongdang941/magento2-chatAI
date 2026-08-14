<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Privacy;

use Afd\AI\Model\Privacy\RetentionCleaner;
use Afd\AI\Model\Privacy\ConversationDataEraser;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\Store;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

class RetentionCleanerTest extends TestCase
{
    public function testUsesConfiguredRetentionAndDeletesOnlyResolvedCases(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->expects(self::once())->method('delete')->willReturn(2);
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->willReturnArgument(0);
        $config = $this->createMock(ScopeConfigInterface::class);
        $config->method('getValue')->willReturnMap([
            ['afd_ai/privacy/conversation_retention_days', ScopeInterface::SCOPE_STORE, 1, '30'],
            ['afd_ai/privacy/resolved_case_retention_days', ScopeInterface::SCOPE_STORE, 1, '365'],
        ]);

        $store = $this->createMock(Store::class);
        $store->method('isActive')->willReturn(true);
        $store->method('getId')->willReturn(1);
        $store->method('getWebsiteId')->willReturn(1);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStores')->with(true)->willReturn([$store]);

        $eraser = $this->createMock(ConversationDataEraser::class);
        $eraser->expects(self::once())
            ->method('eraseExpired')
            ->with('2033-04-18 03:33:20', 1, 1)
            ->willReturn(['conversations' => 4, 'messages' => 12]);

        $result = (new RetentionCleaner($config, $eraser, $resource, $storeManager))->execute(2_000_000_000);
        self::assertSame(['conversations' => 4, 'messages' => 12, 'resolved_cases' => 2], $result);
    }
}
