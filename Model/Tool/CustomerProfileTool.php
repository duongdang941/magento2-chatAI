<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Model\Data\ToolResponseFactory;
use Magento\Authorization\Model\UserContextInterface;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Sales\Model\ResourceModel\Order\CollectionFactory as OrderCollectionFactory;

/** Returns customer-scoped data only for the authenticated Magento customer. */
class CustomerProfileTool
{
    private ToolResponseFactory $toolResponseFactory;
    private CustomerSession $customerSession;
    private OrderCollectionFactory $orderCollectionFactory;
    private UserContextInterface $userContext;
    private CustomerRepositoryInterface $customerRepository;

    public function __construct(
        ToolResponseFactory $toolResponseFactory,
        CustomerSession $customerSession,
        OrderCollectionFactory $orderCollectionFactory,
        UserContextInterface $userContext,
        CustomerRepositoryInterface $customerRepository
    ) {
        $this->toolResponseFactory = $toolResponseFactory;
        $this->customerSession = $customerSession;
        $this->orderCollectionFactory = $orderCollectionFactory;
        $this->userContext = $userContext;
        $this->customerRepository = $customerRepository;
    }


    private function getCurrentCustomerId()
    {
        $userId = $this->userContext->getUserId();
        $userType = $this->userContext->getUserType();

        if ($userId && $userType == \Magento\Authorization\Model\UserContextInterface::USER_TYPE_CUSTOMER) {
            return (int)$userId;
        }

        return $this->customerSession->isLoggedIn() ? (int)$this->customerSession->getCustomerId() : null;
    }

    /**
     * Get current customer object
     *
     * @return \Magento\Customer\Api\Data\CustomerInterface|null
     */
    private function getCurrentCustomer()
    {
        $customerId = $this->getCurrentCustomerId();
        if (!$customerId) {
            return null;
        }

        try {
            return $this->customerRepository->getById($customerId);
        } catch (\Exception $e) {
            return null;
        }
    }
    /**
     * @inheritDoc
     */
    public function getCustomerInfo()
    {
        try {
            $customer = $this->getCurrentCustomer();
            if (!$customer) {
                $result = [
                    'status' => 'NOT_LOGGED_IN',
                    'message' => __('Customer is not logged in.').' '. __('Please log in to see your information.')
                ];
            } else {
                $result = [
                    'status' => 'OK',
                    'name' => $customer->getFirstname() . ' ' . $customer->getLastname(),
                    'email' => $customer->getEmail(),
                    'group_id' => $customer->getGroupId(),
                    'message' => __('Found information for customer %1.', $customer->getFirstname())->render()
                ];
            }
        } catch (\Exception $e) {
            $result = [
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }

    /**
     * @inheritDoc
     */
    public function getRecentOrders(int $limit = 5)
    {
        try {
            $customerId = $this->getCurrentCustomerId();
            if (!$customerId) {
                $result = [
                    'status' => 'NOT_LOGGED_IN',
                    'message' => __('Customer is not logged in.').' '. __('Please log in to see your orders.')
                ];
            } else {
                $collection = $this->orderCollectionFactory->create()
                    ->addFieldToFilter('customer_id', ['eq' => $customerId])
                    ->setOrder('created_at', 'DESC')
                    ->setPageSize($limit);

                $orders = [];
                foreach ($collection as $order) {
                    $orders[] = [
                        'increment_id' => $order->getIncrementId(),
                        'status' => $order->getStatusLabel(),
                        'grand_total' => $order->formatPrice($order->getGrandTotal()),
                        'created_at' => $order->getCreatedAt(),
                        'items_count' => (int)$order->getTotalItemCount()
                    ];
                }

                $result = [
                    'status' => 'OK',
                    'count' => count($orders),
                    'orders' => $orders,
                    'message' => __('Found %1 recent orders.', count($orders))->render()
                ];
            }
        } catch (\Exception $e) {
            $result = [
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }

    /**
     * @inheritDoc
     */
    public function getCustomerAddresses()
    {
        try {
            $customer = $this->getCurrentCustomer();
            if (!$customer) {
                $result = [
                    'status' => 'NOT_LOGGED_IN',
                    'message' => __('Please log in to see your addresses.')
                ];
            } else {
                $addresses = [];
                foreach ($customer->getAddresses() as $address) {
                    $addresses[] = [
                        'id' => $address->getId(),
                        'firstname' => $address->getFirstname(),
                        'lastname' => $address->getLastname(),
                        'street' => implode(', ', $address->getStreet()),
                        'city' => $address->getCity(),
                        'region' => (string)($address->getRegion()?->getRegion() ?? $address->getRegionId() ?? ''),
                        'postcode' => $address->getPostcode(),
                        'country_id' => $address->getCountryId(),
                        'telephone' => $address->getTelephone(),
                        'is_default_billing' => (bool)$address->isDefaultBilling(),
                        'is_default_shipping' => (bool)$address->isDefaultShipping()
                    ];
                }
                $result = [
                    'status' => 'OK',
                    'addresses' => $addresses,
                    'message' => __('Found %1 addresses.', count($addresses))->render()
                ];
            }
        } catch (\Exception $e) {
            $result = [
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        return $response;
    }
}
