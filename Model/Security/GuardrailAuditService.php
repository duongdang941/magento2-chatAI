<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

class GuardrailAuditService
{
    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /** @param array<string,mixed> $data */
    public function record(array $data): array
    {
        $store = $this->storeManager->getStore();
        if (!$this->scopeConfig->isSetFlag('afd_ai/features/guardrails_enabled', ScopeInterface::SCOPE_STORE, (int)$store->getId())) {
            return ['status' => 'unavailable', 'reason' => 'guardrails_disabled'];
        }
        $id = strtolower(trim((string)($data['decision_id'] ?? '')));
        $tool = trim((string)($data['tool_name'] ?? ''));
        $decision = $data['decision'] === 'allowed' ? 'allowed' : 'blocked';
        $reason = trim((string)($data['reason'] ?? ''));
        $risk = trim((string)($data['risk'] ?? ''));
        if (!preg_match('/^[a-f0-9-]{16,64}$/', $id) || !preg_match('/^[A-Za-z][A-Za-z0-9]{0,79}$/', $tool) || $reason === '' || $risk === '') {
            return ['status' => 'error', 'reason' => 'invalid_audit'];
        }
        $customerId = max(0, (int)($data['customer_id'] ?? 0));
        $guestId = strtolower(trim((string)($data['guest_id'] ?? '')));
        if ($customerId === 0 && $guestId !== '' && !preg_match('/^[a-f0-9]{64}$/', $guestId)) return ['status' => 'error', 'reason' => 'invalid_identity'];
        try {
            $this->resource->getConnection()->insert($this->resource->getTableName('afd_ai_guardrail_audit'), [
                'decision_id' => $id, 'conversation_id' => max(0, (int)($data['conversation_id'] ?? 0)) ?: null,
                'tool_name' => $tool, 'decision' => $decision, 'reason' => mb_substr($reason, 0, 80), 'risk' => mb_substr($risk, 0, 32),
                'provider' => mb_substr(trim((string)($data['provider'] ?? '')), 0, 32) ?: null,
                'store_id' => (int)$store->getId(), 'website_id' => (int)$store->getWebsiteId(),
                'customer_id' => $customerId ?: null, 'guest_id' => $customerId ? null : ($guestId ?: null), 'created_at' => gmdate('Y-m-d H:i:s'),
            ]);
            return ['status' => 'success'];
        } catch (\Throwable $error) {
            if (str_contains(strtolower($error->getMessage()), 'duplicate')) return ['status' => 'success', 'duplicate' => true];
            throw $error;
        }
    }
}
