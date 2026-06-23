<?php
declare(strict_types=1);

namespace Afd\AI\Model\Customer;

use Afd\AI\Model\Order\OrderAddressFormMetadata;
use Magento\Customer\Api\AddressRepositoryInterface;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Customer\Api\Data\AddressInterface;
use Magento\Customer\Api\Data\AddressInterfaceFactory;
use Magento\Customer\Api\Data\CustomerInterface;
use Magento\Customer\Api\Data\RegionInterfaceFactory as CustomerRegionFactory;
use Magento\Directory\Model\RegionFactory as DirectoryRegionFactory;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Exception\LocalizedException;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Customer-owned default billing and shipping address operations. */
class CustomerAddressService
{
    public function __construct(
        private readonly CustomerRepositoryInterface $customerRepository,
        private readonly AddressRepositoryInterface $addressRepository,
        private readonly AddressInterfaceFactory $addressFactory,
        private readonly CustomerRegionFactory $customerRegionFactory,
        private readonly DirectoryRegionFactory $directoryRegionFactory,
        private readonly StoreManagerInterface $storeManager,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly OrderAddressFormMetadata $addressFormMetadata
    ) {
    }

    /** @return array<string, mixed> */
    public function getDefaultAddresses(int $customerId): array
    {
        $customer = $this->getCustomer($customerId);
        if (!$customer) {
            return $this->notLoggedIn();
        }

        $storeId = (int)$this->storeManager->getStore()->getId();

        return [
            'status' => 'success',
            'address_types' => ['billing', 'shipping'],
            'addresses' => [
                'billing' => $this->defaultAddress($customer, 'billing'),
                'shipping' => $this->defaultAddress($customer, 'shipping'),
            ],
            'address_form' => $this->addressFormMetadata->forCustomerAccount($storeId),
        ];
    }

    /** @param array<string, mixed> $changes @return array<string, mixed> */
    public function updateDefaultAddress(int $customerId, string $addressType, array $changes): array
    {
        $customer = $this->getCustomer($customerId);
        if (!$customer) {
            return $this->notLoggedIn();
        }

        $addressType = strtolower(trim($addressType));
        if (!in_array($addressType, ['billing', 'shipping'], true)) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'invalid_address_type',
                'message' => __('Please choose the default billing or shipping address.')->render(),
            ];
        }

        try {
            $defaultId = $addressType === 'billing'
                ? (int)$customer->getDefaultBilling()
                : (int)$customer->getDefaultShipping();
            $address = $defaultId > 0
                ? $this->ownedAddress($customerId, $defaultId)
                : $this->addressFactory->create()->setCustomerId($customerId);
            if (!$address) {
                return [
                    'status' => 'requires_customer_action',
                    'reason' => 'address_not_owned',
                    'message' => __('This address does not belong to your account.')->render(),
                ];
            }

            $storeId = (int)$this->storeManager->getStore()->getId();
            $before = $defaultId > 0 ? $this->formatAddress($address) : null;
            $this->applyChanges($address, $changes, $customer, $storeId);
            if ($addressType === 'billing') {
                $address->setIsDefaultBilling(true);
            } else {
                $address->setIsDefaultShipping(true);
            }

            $normalized = $this->formatAddress($address);
            if ($before !== null && $before === $normalized) {
                return [
                    'status' => 'success',
                    'reason' => 'no_change',
                    'address_type' => $addressType,
                    'address' => $normalized,
                    'message' => __('No address changes were needed.')->render(),
                ];
            }

            $saved = $this->addressRepository->save($address);

            return [
                'status' => 'success',
                'address_type' => $addressType,
                'address' => $this->formatAddress($saved),
                'message' => __('Your default %1 address was updated.', $addressType)->render(),
            ];
        } catch (LocalizedException $exception) {
            return [
                'status' => 'requires_customer_action',
                'reason' => 'invalid_address',
                'message' => $exception->getMessage(),
            ];
        } catch (\Throwable) {
            return [
                'status' => 'error',
                'reason' => 'address_update_failed',
                'message' => __('Your account address could not be updated.')->render(),
            ];
        }
    }

    private function getCustomer(int $customerId): ?CustomerInterface
    {
        if ($customerId < 1) {
            return null;
        }

        try {
            return $this->customerRepository->getById($customerId);
        } catch (\Throwable) {
            return null;
        }
    }

    /** @return array<string, mixed> */
    private function defaultAddress(CustomerInterface $customer, string $type): array
    {
        $defaultId = $type === 'billing'
            ? (int)$customer->getDefaultBilling()
            : (int)$customer->getDefaultShipping();
        $address = $defaultId > 0 ? $this->ownedAddress((int)$customer->getId(), $defaultId) : null;

        return $address
            ? $this->formatAddress($address)
            : $this->emptyAddress($customer);
    }

    private function ownedAddress(int $customerId, int $addressId): ?AddressInterface
    {
        try {
            $address = $this->addressRepository->getById($addressId);
            return (int)$address->getCustomerId() === $customerId ? $address : null;
        } catch (\Throwable) {
            return null;
        }
    }

    /** @param array<string, mixed> $changes */
    private function applyChanges(
        AddressInterface $address,
        array $changes,
        CustomerInterface $customer,
        int $storeId
    ): void {
        $changes = $this->addressFormMetadata->filterCustomerAccountEditableChanges($changes, $storeId);
        $countryId = strtoupper($this->text(
            $changes,
            'country_id',
            (string)($address->getCountryId() ?: $this->defaultCountryId($storeId)),
            2
        ));
        $countryChanged = $countryId !== strtoupper((string)$address->getCountryId());

        $address->setFirstname($this->text($changes, 'firstname', (string)($address->getFirstname() ?: $customer->getFirstname()), 64));
        $address->setLastname($this->text($changes, 'lastname', (string)($address->getLastname() ?: $customer->getLastname()), 64));
        $address->setMiddlename($this->text($changes, 'middlename', (string)$address->getMiddlename(), 64));
        $address->setPrefix($this->text($changes, 'prefix', (string)$address->getPrefix(), 40));
        $address->setSuffix($this->text($changes, 'suffix', (string)$address->getSuffix(), 40));
        $address->setCompany($this->text($changes, 'company', (string)$address->getCompany(), 128));
        $address->setStreet($this->street($changes, $address->getStreet() ?: []));
        $address->setCity($this->text($changes, 'city', (string)$address->getCity(), 128));
        $address->setPostcode($this->text($changes, 'postcode', (string)$address->getPostcode(), 32));
        $address->setCountryId($countryId);
        $address->setTelephone($this->text($changes, 'telephone', (string)$address->getTelephone(), 64));
        $address->setFax($this->text($changes, 'fax', (string)$address->getFax(), 64));
        $address->setVatId($this->text($changes, 'vat_id', (string)$address->getVatId(), 64));

        $currentRegion = $address->getRegion();
        $regionId = array_key_exists('region_id', $changes)
            ? max(0, (int)$changes['region_id'])
            : ($countryChanged ? 0 : (int)$address->getRegionId());
        $regionName = $this->text(
            $changes,
            'region',
            $countryChanged ? '' : (string)($currentRegion?->getRegion() ?? ''),
            128
        );
        $regionCode = $countryChanged ? '' : (string)($currentRegion?->getRegionCode() ?? '');

        if ($regionId > 0) {
            $regionModel = $this->directoryRegionFactory->create()->load($regionId);
            if (!$regionModel->getId() || strtoupper((string)$regionModel->getCountryId()) !== $countryId) {
                throw new LocalizedException(__('The selected region does not belong to the selected country.'));
            }
            $regionName = (string)$regionModel->getName();
            $regionCode = (string)$regionModel->getCode();
        }

        $region = $this->customerRegionFactory->create();
        $region->setRegionId($regionId ?: null);
        $region->setRegion($regionName);
        $region->setRegionCode($regionCode);
        $address->setRegion($region);
        $address->setRegionId($regionId ?: null);
    }

    /** @param array<string, mixed> $changes */
    private function text(array $changes, string $field, string $fallback, int $maxLength): string
    {
        $value = array_key_exists($field, $changes) ? $changes[$field] : $fallback;
        return mb_substr(trim(preg_replace('/\s+/u', ' ', (string)$value) ?? ''), 0, $maxLength);
    }

    /** @param array<string, mixed> $changes @param string[] $fallback @return string[] */
    private function street(array $changes, array $fallback): array
    {
        $source = array_key_exists('street', $changes) && is_array($changes['street'])
            ? $changes['street']
            : $fallback;

        return array_values(array_map(
            static fn ($line): string => mb_substr(trim((string)$line), 0, 255),
            array_slice($source, 0, 4)
        ));
    }

    private function defaultCountryId(int $storeId): string
    {
        return strtoupper((string)$this->scopeConfig->getValue(
            'general/country/default',
            ScopeInterface::SCOPE_STORE,
            $storeId
        ));
    }

    /** @return array<string, mixed> */
    private function emptyAddress(CustomerInterface $customer): array
    {
        return [
            'firstname' => (string)$customer->getFirstname(),
            'lastname' => (string)$customer->getLastname(),
            'street' => [],
            'country_id' => $this->defaultCountryId((int)$this->storeManager->getStore()->getId()),
            'region_id' => 0,
        ];
    }

    /** @return array<string, mixed> */
    private function formatAddress(AddressInterface $address): array
    {
        return [
            'id' => (int)$address->getId(),
            'prefix' => (string)$address->getPrefix(),
            'firstname' => (string)$address->getFirstname(),
            'middlename' => (string)$address->getMiddlename(),
            'lastname' => (string)$address->getLastname(),
            'suffix' => (string)$address->getSuffix(),
            'company' => (string)$address->getCompany(),
            'street' => array_values(array_map('strval', $address->getStreet() ?: [])),
            'city' => (string)$address->getCity(),
            'region' => (string)($address->getRegion()?->getRegion() ?? ''),
            'region_id' => (int)$address->getRegionId(),
            'postcode' => (string)$address->getPostcode(),
            'country_id' => strtoupper((string)$address->getCountryId()),
            'telephone' => (string)$address->getTelephone(),
            'fax' => (string)$address->getFax(),
            'vat_id' => (string)$address->getVatId(),
        ];
    }

    /** @return array<string, string> */
    private function notLoggedIn(): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => 'not_logged_in',
            'message' => __('Please sign in to view or change your account addresses.')->render(),
        ];
    }
}
