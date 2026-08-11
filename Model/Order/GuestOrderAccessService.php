<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Magento\Framework\Exception\LocalizedException;
use Magento\Sales\Api\OrderAddressRepositoryInterface;
use Magento\Sales\Api\OrderRepositoryInterface;
use Magento\Sales\Model\Order;
use Magento\Sales\Model\ResourceModel\Order\CollectionFactory as OrderCollectionFactory;

/**
 * Email-OTP access to guest checkout orders, scoped to one verified chat
 * session. The access table holds hashes only; the raw email and OTP are
 * never persisted.
 */
class GuestOrderAccessService
{
    private const MAX_ORDER_RESULTS = 10;

    public function __construct(
        private readonly GuestOrderVerification $verification,
        private readonly OrderCollectionFactory $orderCollectionFactory,
        private readonly OrderAddressRepositoryInterface $orderAddressRepository,
        private readonly OrderRepositoryInterface $orderRepository,
        private readonly OrderAddressUpdater $orderAddressUpdater,
        private readonly OrderAddressFormMetadata $addressFormMetadata
    ) {
    }

    /** @return array<string, mixed> */
    public function requestOtp(string $email, string $sessionId): array
    {
        return $this->verification->requestOtp($email, $sessionId);
    }

    /** @return array<string, mixed> */
    public function verifyOtp(string $email, string $code, string $sessionId): array
    {
        return $this->verification->verifyOtp($email, $code, $sessionId);
    }

    /** @return array<string, mixed> */
    public function listOrders(string $token, string $sessionId, string $email, int $limit = 5): array
    {
        if (!$this->verification->hasAccess($token, $sessionId, $email)) {
            return $this->accessRequired();
        }

        $email = $this->normalizeEmail($email);
        $orders = [];
        $collection = $this->orderCollectionFactory->create()
            ->addFieldToFilter('customer_is_guest', ['eq' => 1])
            ->addFieldToFilter('customer_email', ['eq' => $email])
            ->setOrder('created_at', 'DESC')
            ->setPageSize(max(1, min($limit, self::MAX_ORDER_RESULTS)));

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
    public function getOrderDetails(string $token, string $sessionId, string $email, string $incrementId): array
    {
        if (!$this->verification->hasAccess($token, $sessionId, $email)) {
            return $this->accessRequired();
        }

        $order = $this->getVerifiedGuestOrder($email, $incrementId);
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
     * Update only an order address snapshot. The verified guest must have
     * completed OTP whose 24-hour verified-access window is still active. The
     * order must also be theirs, active, and completely unshipped.
     *
     * @param array<string, mixed> $changes
     * @return array<string, mixed>
     */
    public function updateOrderAddress(
        string $token,
        string $sessionId,
        string $email,
        string $incrementId,
        string $addressType,
        array $changes
    ): array {
        if (!$this->verification->hasFreshAccess($token, $sessionId, $email)) {
            return $this->requiresAction(
                'guest_reverification_required',
                'Please verify your email again before changing an order address.'
            );
        }

        $order = $this->getVerifiedGuestOrder($email, $incrementId);
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
            return $this->requiresAction(
                'invalid_address_type',
                __('Please choose the billing or shipping address.')->render()
            );
        }

        $address = $addressType === 'billing'
            ? $order->getBillingAddress()
            : $order->getShippingAddress();
        if (!$address) {
            return $this->requiresAction(
                'address_not_available',
                __('This order does not have a %1 address to update.', $addressType)->render()
            );
        }

        try {
            $this->orderAddressUpdater->apply($address, $changes, (int)$order->getStoreId());
            $this->orderAddressRepository->save($address);

            // Keep an auditable but non-sensitive status-history entry. No raw
            // address is placed in the order timeline and no notification is sent.
            $order->addCommentToStatusHistory(
                __('Guest updated the %1 address through Store Assistant.', $addressType),
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
            return $this->requiresAction('invalid_address', $exception->getMessage());
        } catch (\Throwable) {
            return [
                'status' => 'error',
                'reason' => 'address_update_failed',
                'message' => __('The order address could not be updated.')->render(),
            ];
        }
    }

    private function getVerifiedGuestOrder(string $email, string $incrementId): ?Order
    {
        $email = $this->normalizeEmail($email);
        $incrementId = trim($incrementId);
        if ($email === ''
            || $incrementId === ''
            || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $incrementId)
        ) {
            return null;
        }

        /** @var Order $order */
        $order = $this->orderCollectionFactory->create()
            ->addFieldToFilter('customer_is_guest', ['eq' => 1])
            ->addFieldToFilter('customer_email', ['eq' => $email])
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
            'address_change_allowed' => $eligibility['allowed'],
            'address_change_reason' => $eligibility['reason'],
        ];
    }

    private function normalizeEmail(string $email): string
    {
        $email = mb_strtolower(trim($email));

        return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
    }

    /** @return array<string, mixed> */
    private function accessRequired(): array
    {
        return $this->requiresAction(
            'guest_access_required',
            'Verify your email to view or change guest orders.'
        );
    }

    /** @return array<string, mixed> */
    private function orderNotFound(): array
    {
        // Never distinguish a missing order from an order associated with a
        // different email address, so increment IDs cannot be enumerated.
        return $this->requiresAction(
            'order_not_found',
            'That guest order was not found for the verified email address.'
        );
    }

    /** @return array<string, mixed> */
    private function requiresAction(string $reason, string $message): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => $reason,
            'message' => $message,
        ];
    }
}
