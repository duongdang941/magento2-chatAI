<?php
declare(strict_types=1);

namespace Afd\AI\Model\Catalog;

use Magento\Customer\Api\GroupManagementInterface;
use Magento\Customer\Api\GroupRepositoryInterface;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Framework\Exception\AuthorizationException;
use Magento\Framework\Exception\NoSuchEntityException;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Resolves only Magento-owned store and group values for catalogue tools.
 *
 * A customer group from a Magento-signed WebSocket ticket is only an
 * assertion. For an authenticated shopper it is reloaded from Magento on
 * every catalogue request; a mismatch is rejected rather than downgraded.
 */
class ShopperScopeResolver
{
    public function __construct(
        private readonly StoreManagerInterface $storeManager,
        private readonly GroupRepositoryInterface $groupRepository,
        private readonly GroupManagementInterface $groupManagement,
        private readonly CustomerRepositoryInterface $customerRepository
    ) {
    }

    public function resolve(int $requestedCustomerGroupId = 0, int $trustedCustomerId = 0): ShopperScope
    {
        $store = $this->storeManager->getStore();
        if (!(bool)$store->isActive()) {
            throw new AuthorizationException(__('The requested store is unavailable.'));
        }

        $customerGroupId = $trustedCustomerId > 0
            ? $this->resolveAuthenticatedCustomerGroupId($trustedCustomerId, $requestedCustomerGroupId)
            : $this->resolveGuestGroupId($requestedCustomerGroupId);

        return new ShopperScope(
            (int)$store->getId(),
            (string)$store->getCode(),
            (int)$store->getWebsiteId(),
            $customerGroupId
        );
    }

    private function resolveGuestGroupId(int $requestedCustomerGroupId): int
    {
        $guestGroupId = (int)$this->groupManagement->getNotLoggedInGroup()->getId();
        if ($requestedCustomerGroupId > 0 && $requestedCustomerGroupId !== $guestGroupId) {
            throw new AuthorizationException(__('The customer group does not match the shopper identity.'));
        }

        return $guestGroupId;
    }

    private function resolveAuthenticatedCustomerGroupId(int $customerId, int $requestedCustomerGroupId): int
    {
        try {
            $customer = $this->customerRepository->getById($customerId);
            $customerGroupId = (int)$this->groupRepository
                ->getById((int)$customer->getGroupId())
                ->getId();
        } catch (NoSuchEntityException) {
            throw new AuthorizationException(__('The customer scope could not be verified.'));
        }

        if ($requestedCustomerGroupId > 0 && $requestedCustomerGroupId !== $customerGroupId) {
            throw new AuthorizationException(__('The customer group has changed. Reconnect the chat.'));
        }

        return $customerGroupId;
    }
}
