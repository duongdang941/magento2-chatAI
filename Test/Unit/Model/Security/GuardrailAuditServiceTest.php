<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Security;

use Afd\AI\Model\Security\GuardrailAuditService;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;

class GuardrailAuditServiceTest extends TestCase
{
    public function testWritesOnlyStructuredPolicyDecisionMetadata(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->expects(self::once())->method('insert')->with(
            'afd_ai_guardrail_audit',
            self::callback(static function (array $row): bool {
                self::assertSame('cancelOrder', $row['tool_name']);
                self::assertSame('blocked', $row['decision']);
                self::assertSame('explicit_confirmation_required', $row['reason']);
                self::assertSame('destructive', $row['risk']);
                self::assertSame(12, $row['conversation_id']);
                self::assertSame(3, $row['store_id']);
                return true;
            })
        );
        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_guardrail_audit')->willReturn('afd_ai_guardrail_audit');

        $store = $this->createMock(StoreInterface::class);
        $store->method('getId')->willReturn(3);
        $store->method('getWebsiteId')->willReturn(2);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);
        $config = $this->createMock(ScopeConfigInterface::class);
        $config->method('isSetFlag')->with(
            'afd_ai/features/guardrails_enabled',
            ScopeInterface::SCOPE_STORE,
            3
        )->willReturn(true);

        $service = new GuardrailAuditService($resource, $config, $storeManager);
        self::assertSame(['status' => 'success'], $service->record([
            'decision_id' => '8a5e5f9d-0028-4c08-8c0a-1e680d741ffa',
            'conversation_id' => 12,
            'tool_name' => 'cancelOrder',
            'decision' => 'blocked',
            'reason' => 'explicit_confirmation_required',
            'risk' => 'destructive',
            'guest_id' => str_repeat('a', 64),
        ]));
    }
}
