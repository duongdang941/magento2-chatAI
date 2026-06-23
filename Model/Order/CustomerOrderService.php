<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Afd\AI\Model\Security\ActionRateLimiter;
use Afd\AI\Model\Support\SupportCaseService;
use Magento\Framework\Exception\LocalizedException;
use Magento\Sales\Api\OrderAddressRepositoryInterface;
use Magento\Sales\Api\OrderManagementInterface;
use Magento\Sales\Api\OrderRepositoryInterface;
use Magento\Sales\Model\Order;
use Magento\Sales\Model\ResourceModel\Order\CollectionFactory as OrderCollectionFactory;

/**
 * Customer-scoped order lookup and address changes for the trusted AI gateway.
 *
 * The caller supplies the customer ID from a verified WebSocket ticket. Every
 * lookup includes that ID in the Magento query; an order number alone never
 * grants access to another customer's order.
 */
class CustomerOrderService
{
    private const MAX_ORDER_RESULTS = 10;

    public function __construct(
        private readonly OrderCollectionFactory $orderCollectionFactory,
        private readonly OrderAddressRepositoryInterface $orderAddressRepository,
        private readonly OrderRepositoryInterface $orderRepository,
        private readonly OrderAddressUpdater $orderAddressUpdater,
        private readonly OrderAddressFormMetadata $addressFormMetadata,
        private readonly OrderManagementInterface $orderManagement,
        private readonly ActionRateLimiter $rateLimiter,
        private readonly SupportCaseService $supportCaseService
    ) {
    }

    /** @return array<string, mixed> */
    public function getFulfillmentDetails(int $customerId, string $incrementId): array
    {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }
        $order = $this->getOwnedOrder($customerId, $incrementId);
        if (!$order) {
            return $this->orderNotFound();
        }

        $shipments = [];
        foreach ($order->getShipmentsCollection() as $shipment) {
            $tracks = [];
            foreach ($shipment->getAllTracks() as $track) {
                $tracks[] = [
                    'carrier_code' => (string)$track->getCarrierCode(),
                    'carrier_title' => (string)$track->getTitle(),
                    'tracking_number' => (string)$track->getTrackNumber(),
                ];
            }
            $shipments[] = [
                'shipment_number' => (string)$shipment->getIncrementId(),
                'created_at' => (string)$shipment->getCreatedAt(),
                'tracks' => $tracks,
            ];
        }

        $invoices = [];
        foreach ($order->getInvoiceCollection() as $invoice) {
            $invoices[] = [
                'invoice_number' => (string)$invoice->getIncrementId(),
                'state' => (int)$invoice->getState(),
                'grand_total' => (float)$invoice->getGrandTotal(),
                'created_at' => (string)$invoice->getCreatedAt(),
            ];
        }

        $creditMemos = [];
        foreach ($order->getCreditmemosCollection() as $creditMemo) {
            $creditMemos[] = [
                'credit_memo_number' => (string)$creditMemo->getIncrementId(),
                'grand_total' => (float)$creditMemo->getGrandTotal(),
                'created_at' => (string)$creditMemo->getCreatedAt(),
            ];
        }

        return [
            'status' => 'success',
            'order' => $this->summarizeOrder($order) + [
                'can_cancel' => $order->canCancel(),
                'shipments' => $shipments,
                'invoices' => $invoices,
                'credit_memos' => $creditMemos,
            ],
        ];
    }

    /** @return array<string, mixed> */
    public function cancelOrder(int $customerId, string $incrementId, bool $confirmed): array
    {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }
        $order = $this->getOwnedOrder($customerId, $incrementId);
        if (!$order) {
            return $this->orderNotFound();
        }
        if (!$confirmed) {
            return [
                'status' => 'requires_confirmation',
                'reason' => 'cancellation_confirmation_required',
                'order_number' => (string)$order->getIncrementId(),
                'message' => __('Please explicitly confirm that you want to cancel this order.')->render(),
            ];
        }
        if (!$order->canCancel()) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'order_cannot_be_cancelled',
                'message' => __('This order can no longer be cancelled automatically.')->render(),
            ];
        }
        $throttle = $this->rateLimiter->consume('cancel_order', 'customer:' . $customerId, 3, 3600);
        if (!$throttle['allowed']) {
            return ['status' => 'rate_limited', 'retry_after' => $throttle['retry_after'], 'message' => __('Please wait before trying another cancellation.')->render()];
        }

        try {
            $this->orderManagement->cancel((int)$order->getEntityId());
            return [
                'status' => 'success',
                'order_number' => (string)$order->getIncrementId(),
                'message' => __('Order %1 was cancelled.', $order->getIncrementId())->render(),
            ];
        } catch (LocalizedException $exception) {
            return ['status' => 'requires_customer_action', 'reason' => 'cancellation_rejected', 'message' => $exception->getMessage()];
        } catch (\Throwable) {
            return ['status' => 'error', 'reason' => 'cancellation_failed', 'message' => __('The order could not be cancelled.')->render()];
        }
    }

    /** @return array<string, mixed> */
    public function requestReturn(
        int $customerId,
        string $incrementId,
        int $conversationId,
        string $reason,
        array $skus = []
    ): array {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }
        $order = $this->getOwnedOrder($customerId, $incrementId);
        if (!$order) {
            return $this->orderNotFound();
        }
        $reason = trim($reason);
        if ($reason === '') {
            return ['status' => 'requires_customer_action', 'reason' => 'return_reason_required', 'message' => __('Tell me why you want to return the item.')->render()];
        }
        $orderedSkus = [];
        foreach ($order->getAllVisibleItems() as $item) {
            $orderedSkus[(string)$item->getSku()] = true;
        }
        $requestedSkus = array_values(array_filter(array_unique(array_map('strval', $skus)), static fn (string $sku): bool => isset($orderedSkus[$sku])));

        return $this->supportCaseService->create(
            $conversationId,
            $customerId,
            null,
            'return',
            (string)__('Return request for order %1', $order->getIncrementId()),
            mb_substr($reason, 0, 4000),
            'normal',
            ['order_number' => (string)$order->getIncrementId(), 'product_skus' => $requestedSkus]
        );
    }

    /** @return array<string, mixed> */
    public function listRecentOrders(int $customerId, int $limit = 5): array
    {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }

        $limit = max(1, min($limit, self::MAX_ORDER_RESULTS));
        $orders = [];
        $collection = $this->orderCollectionFactory->create()
            ->addFieldToFilter('customer_id', ['eq' => $customerId])
            ->setOrder('created_at', 'DESC')
            ->setPageSize($limit);

        foreach ($collection as $order) {
            $orders[] = $this->summarizeOrder($order);
        }

        return [
            'status' => 'success',
            'count' => count($orders),
            'orders' => $orders,
        ];
    }

    /** @return array<string, mixed> */
    public function getOrderDetails(int $customerId, string $incrementId): array
    {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }

        $order = $this->getOwnedOrder($customerId, $incrementId);
        if (!$order) {
            return $this->orderNotFound();
        }

        $items = [];
        foreach ($order->getAllVisibleItems() as $item) {
            $items[] = [
                'name' => (string)$item->getName(),
                'sku' => (string)$item->getSku(),
                'qty_ordered' => (float)$item->getQtyOrdered(),
                'qty_shipped' => (float)$item->getQtyShipped(),
            ];
        }

        return [
            'status' => 'success',
            'order' => $this->summarizeOrder($order) + [
                'items' => $items,
                'billing_address' => $this->orderAddressUpdater->format($order->getBillingAddress()),
                'shipping_address' => $this->orderAddressUpdater->format($order->getShippingAddress()),
                'address_form' => $this->addressFormMetadata->forStore((int)$order->getStoreId()),
            ],
        ];
    }

    /**
     * Update the address snapshot on an active, completely unshipped order.
     * This intentionally does not write to the customer's address book.
     *
     * @param array<string, mixed> $changes
     * @return array<string, mixed>
     */
    public function updateOrderAddress(
        int $customerId,
        string $incrementId,
        string $addressType,
        array $changes
    ): array {
        if ($customerId < 1) {
            return $this->notLoggedIn();
        }

        $order = $this->getOwnedOrder($customerId, $incrementId);
        if (!$order) {
            return $this->orderNotFound();
        }

        $eligibility = $this->orderAddressUpdater->eligibility($order);
        if (!$eligibility['allowed']) {
            return [
                'status' => 'requires_customer_action',
                'reason' => $eligibility['reason'],
                'message' => $eligibility['message'],
                'order_number' => (string)$order->getIncrementId(),
            ];
        }

        $addressType = strtolower(trim($addressType));
        if (!in_array($addressType, ['billing', 'shipping'], true)) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'invalid_address_type',
                'message' => __('Please choose the billing or shipping address.')->render(),
            ];
        }

        $address = $addressType === 'billing'
            ? $order->getBillingAddress()
            : $order->getShippingAddress();
        if (!$address) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'address_not_available',
                'message' => __('This order does not have a %1 address to update.', $addressType)->render(),
            ];
        }

        try {
            $this->orderAddressUpdater->apply($address, $changes, (int)$order->getStoreId());
            $this->orderAddressRepository->save($address);

            // Keep a non-sensitive audit trail on the order without notifying
            // the customer or changing the order status.
            $order->addCommentToStatusHistory(
                __('Customer updated the %1 address through Store Assistant.', $addressType),
                false,
                false
            );
            $this->orderRepository->save($order);

            return [
                'status' => 'success',
                'order_number' => (string)$order->getIncrementId(),
                'address_type' => $addressType,
                'address' => $this->orderAddressUpdater->format($address),
                'message' => __('The %1 address was updated.', $addressType)->render(),
            ];
        } catch (LocalizedException $exception) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'invalid_address',
                'message' => $exception->getMessage(),
            ];
        } catch (\Throwable $exception) {
            return [
                'status' => 'error',
                'reason' => 'address_update_failed',
                'message' => __('The order address could not be updated.')->render(),
            ];
        }
    }

    private function getOwnedOrder(int $customerId, string $incrementId): ?Order
    {
        $incrementId = trim($incrementId);
        if ($customerId < 1 || $incrementId === '' || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $incrementId)) {
            return null;
        }

        /** @var Order $order */
        $order = $this->orderCollectionFactory->create()
            ->addFieldToFilter('customer_id', ['eq' => $customerId])
            ->addFieldToFilter('increment_id', ['eq' => $incrementId])
            ->setPageSize(1)
            ->getFirstItem();

        return $order->getId() ? $order : null;
    }

    /** @return array<string, mixed> */
    private function summarizeOrder(Order $order): array
    {
        $eligibility = $this->orderAddressUpdater->eligibility($order);

        return [
            'order_number' => (string)$order->getIncrementId(),
            'status' => (string)$order->getStatusLabel(),
            'state' => (string)$order->getState(),
            'created_at' => (string)$order->getCreatedAt(),
            'grand_total' => (float)$order->getGrandTotal(),
            'currency_code' => (string)$order->getOrderCurrencyCode(),
            'items_count' => (int)$order->getTotalItemCount(),
            'has_shipments' => $order->hasShipments(),
            'can_cancel' => $order->canCancel(),
            'address_change_allowed' => $eligibility['allowed'],
            'address_change_reason' => $eligibility['reason'],
        ];
    }

    /** @return array<string, mixed> */
    private function notLoggedIn(): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => 'not_logged_in',
            'message' => __('Please sign in to view or change your orders.')->render(),
        ];
    }

    /** @return array<string, mixed> */
    private function orderNotFound(): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => 'order_not_found',
            // Never distinguish a missing order from an order owned by a
            // different customer, otherwise order numbers become enumerable.
            'message' => __('That order was not found in your account.')->render(),
        ];
    }
}
