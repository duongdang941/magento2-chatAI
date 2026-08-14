<?php
declare(strict_types=1);

namespace Afd\AI\Model\Analytics;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\Quote\Model\Quote;
use Magento\Sales\Api\Data\OrderInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Durable, idempotent, minimal telemetry for AI-assisted commerce attribution. */
class AnalyticsEventService
{
    private const EVENT_NAMES = [
        'assistant_opened', 'message_sent', 'answer_completed', 'recommendation_shown',
        'product_opened', 'comparison_shown', 'add_to_cart', 'checkout_started',
        'order_placed', 'order_refunded', 'order_cancelled', 'knowledge_cited',
        'no_answer', 'handoff_opened', 'feedback_submitted',
    ];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly StoreManagerInterface $storeManager,
        private readonly Json $json
    ) {
    }

    /** @param array<string,mixed> $event @return array<string,mixed> */
    public function record(array $event): array
    {
        $store = $this->storeManager->getStore();
        return $this->recordForStore($event, (int)$store->getId(), (int)$store->getWebsiteId());
    }

    /**
     * Correlate a checkout submission only when this quote previously had an
     * AI-assisted cart action. A normal storefront checkout must never create
     * an AI attribution record by itself.
     */
    public function recordCheckoutStarted(Quote $quote): array
    {
        return $this->recordQuoteLifecycle(
            'checkout_started',
            max(0, (int)$quote->getId()),
            max(0, (int)$quote->getStoreId()),
            (int)$quote->getCustomerId(),
            (float)$quote->getGrandTotal(),
            (string)$quote->getQuoteCurrencyCode(),
            $this->itemSkus($quote->getAllVisibleItems()),
            'quote:' . (int)$quote->getId()
        );
    }

    public function recordOrderPlaced(OrderInterface $order): array
    {
        return $this->recordQuoteLifecycle(
            'order_placed',
            max(0, (int)$order->getQuoteId()),
            max(0, (int)$order->getStoreId()),
            (int)$order->getCustomerId(),
            (float)$order->getGrandTotal(),
            (string)$order->getOrderCurrencyCode(),
            $this->itemSkus($order->getAllVisibleItems()),
            'order:' . (string)$order->getIncrementId(),
            (string)$order->getIncrementId()
        );
    }

    public function recordOrderRefunded(OrderInterface $order, int $creditmemoId, float $amount): array
    {
        return $this->recordQuoteLifecycle(
            'order_refunded',
            max(0, (int)$order->getQuoteId()),
            max(0, (int)$order->getStoreId()),
            (int)$order->getCustomerId(),
            $amount,
            (string)$order->getOrderCurrencyCode(),
            $this->itemSkus($order->getAllVisibleItems()),
            'creditmemo:' . max(0, $creditmemoId),
            (string)$order->getIncrementId()
        );
    }

    public function recordOrderCancelled(OrderInterface $order): array
    {
        return $this->recordQuoteLifecycle(
            'order_cancelled',
            max(0, (int)$order->getQuoteId()),
            max(0, (int)$order->getStoreId()),
            (int)$order->getCustomerId(),
            (float)$order->getGrandTotal(),
            (string)$order->getOrderCurrencyCode(),
            $this->itemSkus($order->getAllVisibleItems()),
            'order:' . (string)$order->getIncrementId(),
            (string)$order->getIncrementId()
        );
    }

    /** @param array<string,mixed> $event @return array<string,mixed> */
    private function recordForStore(array $event, int $storeId, int $websiteId): array
    {
        if (!$this->scopeConfig->isSetFlag('afd_ai/features/analytics_attribution_enabled', ScopeInterface::SCOPE_STORE, $storeId)) {
            return ['status' => 'unavailable', 'reason' => 'analytics_disabled'];
        }

        $eventId = strtolower(trim((string)($event['event_id'] ?? '')));
        $name = strtolower(trim((string)($event['event_name'] ?? '')));
        if (!$this->isEventId($eventId) || !in_array($name, self::EVENT_NAMES, true)) {
            return ['status' => 'error', 'reason' => 'invalid_event'];
        }

        $customerId = max(0, (int)($event['customer_id'] ?? 0));
        $guestId = strtolower(trim((string)($event['guest_id'] ?? '')));
        if ($customerId < 1 && $guestId !== '' && !preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            return ['status' => 'error', 'reason' => 'invalid_identity'];
        }

        $payload = $this->sanitizePayload($event['payload'] ?? []);
        $connection = $this->resource->getConnection();
        try {
            $connection->insert($this->resource->getTableName('afd_ai_analytics_event'), [
                'event_id' => $eventId,
                'event_name' => $name,
                'conversation_id' => max(0, (int)($event['conversation_id'] ?? 0)) ?: null,
                'candidate_set_id' => $this->bounded($event['candidate_set_id'] ?? '', 128) ?: null,
                'quote_id' => max(0, (int)($event['quote_id'] ?? 0)) ?: null,
                'order_increment_id' => $this->bounded($event['order_increment_id'] ?? '', 32) ?: null,
                'customer_id' => $customerId > 0 ? $customerId : null,
                'guest_id' => $customerId > 0 ? null : ($guestId ?: null),
                'store_id' => $storeId,
                'website_id' => $websiteId,
                'provider' => $this->bounded($event['provider'] ?? '', 32) ?: null,
                'model' => $this->bounded($event['model'] ?? '', 128) ?: null,
                'payload_json' => $payload === [] ? null : $this->json->serialize($payload),
                'occurred_at' => gmdate('Y-m-d H:i:s', max(1, min(time(), (int)($event['occurred_at'] ?? time())))),
                'created_at' => gmdate('Y-m-d H:i:s'),
            ]);
            return ['status' => 'success', 'event_id' => $eventId];
        } catch (\Throwable $error) {
            // Duplicate retries are success-equivalent. Do not turn a healthy
            // shopper request into an error merely because telemetry retried.
            if (str_contains(strtolower($error->getMessage()), 'duplicate')) {
                return ['status' => 'success', 'event_id' => $eventId, 'duplicate' => true];
            }
            throw $error;
        }
    }

    /** @return array<string,mixed> */
    private function recordQuoteLifecycle(
        string $eventName,
        int $quoteId,
        int $storeId,
        int $customerId,
        float $amount,
        string $currency,
        array $productSkus,
        string $sourceId,
        string $orderIncrementId = ''
    ): array {
        if ($quoteId < 1 || $storeId < 1 || !in_array($eventName, self::EVENT_NAMES, true)) {
            return ['status' => 'unavailable', 'reason' => 'missing_commerce_correlation'];
        }
        try {
            $store = $this->storeManager->getStore($storeId);
            $connection = $this->resource->getConnection();
            $table = $this->resource->getTableName('afd_ai_analytics_event');
            $seed = $connection->fetchRow(
                $connection->select()
                    ->from($table, ['conversation_id', 'candidate_set_id', 'customer_id', 'guest_id', 'provider', 'model'])
                    ->where('quote_id = ?', $quoteId)
                    ->where('store_id = ?', $storeId)
                    ->where('event_name = ?', 'add_to_cart')
                    ->order('occurred_at DESC')
                    ->limit(1)
            );
            if (!is_array($seed) || $seed === []) {
                return ['status' => 'unavailable', 'reason' => 'no_ai_assisted_quote'];
            }

            return $this->recordForStore([
                'event_id' => hash('sha256', 'afd-ai-commerce-lifecycle-v1|' . $eventName . '|' . $sourceId),
                'event_name' => $eventName,
                'conversation_id' => (int)($seed['conversation_id'] ?? 0),
                'candidate_set_id' => (string)($seed['candidate_set_id'] ?? ''),
                'quote_id' => $quoteId,
                'order_increment_id' => $orderIncrementId,
                'customer_id' => $customerId > 0 ? $customerId : (int)($seed['customer_id'] ?? 0),
                'guest_id' => $customerId > 0 ? '' : (string)($seed['guest_id'] ?? ''),
                'provider' => (string)($seed['provider'] ?? ''),
                'model' => (string)($seed['model'] ?? ''),
                'payload' => [
                    'amount' => max(0, $amount),
                    'currency' => $currency,
                    'product_skus' => $productSkus,
                ],
            ], $storeId, (int)$store->getWebsiteId());
        } catch (\Throwable) {
            // Commerce completion must remain independent of analytics health.
            return ['status' => 'unavailable', 'reason' => 'commerce_correlation_unavailable'];
        }
    }

    private function isEventId(string $eventId): bool
    {
        return (bool)preg_match('/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/', $eventId);
    }

    /** @param array<int,mixed> $items @return array<int,string> */
    private function itemSkus(array $items): array
    {
        return array_values(array_unique(array_filter(array_map(
            fn ($item): string => $this->bounded(is_object($item) && method_exists($item, 'getSku') ? $item->getSku() : '', 64),
            array_slice($items, 0, 20)
        ), static fn (string $sku): bool => (bool)preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $sku))));
    }

    /** @return array<string,mixed> */
    private function sanitizePayload(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) return [];
        $payload = [];
        $skus = is_array($value['product_skus'] ?? null) ? $value['product_skus'] : [];
        $safeSkus = array_values(array_filter(array_map(
            fn ($sku): string => $this->bounded($sku, 64),
            array_slice($skus, 0, 20)
        ), static fn (string $sku): bool => (bool)preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $sku)));
        if ($safeSkus !== []) $payload['product_skus'] = $safeSkus;
        foreach (['currency' => 8, 'reason' => 64, 'rating' => 16] as $key => $limit) {
            $text = $this->bounded($value[$key] ?? '', $limit);
            if ($text !== '') $payload[$key] = $text;
        }
        foreach (['amount', 'latency_ms'] as $key) {
            if (isset($value[$key]) && is_numeric($value[$key])) $payload[$key] = max(0, min(100000000, (float)$value[$key]));
        }
        $flags = is_array($value['feature_flags'] ?? null) ? $value['feature_flags'] : [];
        if ($flags !== [] && !array_is_list($flags)) {
            $payload['feature_flags'] = array_slice(array_filter($flags, static fn ($flag): bool => is_bool($flag)), 0, 16, true);
        }
        return $payload;
    }

    private function bounded(mixed $value, int $limit): string
    {
        return mb_substr(trim((string)$value), 0, $limit);
    }
}
