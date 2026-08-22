<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Analytics;

use Afd\AI\Model\Analytics\AnalyticsEventService;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

class AnalyticsEventServiceTest extends TestCase
{
    public function testRejectsMalformedEventIdsBeforeAccessingStorage(): void
    {
        $resource = $this->createMock(ResourceConnection::class);
        $resource->expects(self::never())->method('getConnection');

        $service = $this->service($resource, true);
        self::assertSame('error', $service->record([
            'event_id' => 'not-a-uuid',
            'event_name' => 'answer_completed',
        ])['status']);
    }

    public function testRecordsOnlySanitizedMetadataWithQuoteCorrelation(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->expects(self::once())->method('insert')->with(
            'afd_ai_analytics_event',
            self::callback(static function (array $row): bool {
                self::assertSame(42, $row['conversation_id']);
                self::assertSame(99, $row['quote_id']);
                self::assertSame('100000123', $row['order_increment_id']);
                self::assertSame(3, $row['store_id']);
                self::assertSame(2, $row['website_id']);
                self::assertSame('gemini', $row['provider']);
                self::assertSame('{"product_skus":["SKU-1"],"latency_ms":21}', $row['payload_json']);
                return true;
            })
        );
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_analytics_event')->willReturn('afd_ai_analytics_event');

        $service = $this->service($resource, true);
        $result = $service->record([
            'event_id' => '8a5e5f9d-0028-4c08-8c0a-1e680d741ffa',
            'event_name' => 'answer_completed',
            'conversation_id' => 42,
            'quote_id' => 99,
            'order_increment_id' => '100000123',
            'provider' => 'gemini',
            'payload' => [
                'product_skus' => ['SKU-1', '<script>'],
                'latency_ms' => 21,
                'raw_message' => 'must never be persisted',
            ],
        ]);

        self::assertSame(['status' => 'success', 'event_id' => '8a5e5f9d-0028-4c08-8c0a-1e680d741ffa'], $result);
    }

    private function service(ResourceConnection $resource, bool $enabled): AnalyticsEventService
    {
        $store = $this->createMock(StoreInterface::class);
        $store->method('getId')->willReturn(3);
        $store->method('getWebsiteId')->willReturn(2);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);
        $config = $this->createMock(ScopeConfigInterface::class);
        $config->method('isSetFlag')->with(
            'afd_ai/features/analytics_attribution_enabled',
            ScopeInterface::SCOPE_STORE,
            3
        )->willReturn($enabled);
        $json = $this->createMock(Json::class);
        $json->method('serialize')->willReturnCallback(static fn (array $value): string => json_encode($value, JSON_THROW_ON_ERROR));

        return new AnalyticsEventService($resource, $config, $storeManager, $json);
    }
}
