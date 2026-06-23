<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Magento\Customer\Model\Metadata\FormFactory as CustomerFormFactory;
use Magento\Directory\Helper\Data as DirectoryHelper;
use Magento\Directory\Model\ResourceModel\Country\CollectionFactory as CountryCollectionFactory;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Exposes the same customer-address metadata that Magento Admin uses when an
 * administrator opens Sales > Orders > Edit Address.  The chat never decides
 * which fields are editable itself: it receives the store-specific schema.
 */
class OrderAddressFormMetadata
{
    private const ORDER_FORM_CODE = 'adminhtml_customer_address';
    private const CUSTOMER_ACCOUNT_FORM_CODE = 'customer_address_edit';

    /** @var string[] */
    private const ORDER_ADDRESS_FIELDS = [
        'prefix',
        'firstname',
        'middlename',
        'lastname',
        'suffix',
        'company',
        'street',
        'city',
        'region',
        'postcode',
        'country_id',
        'telephone',
        'fax',
        'vat_id',
    ];

    /** @var array<string, array<string, mixed>> */
    private array $cache = [];

    public function __construct(
        private readonly CustomerFormFactory $customerFormFactory,
        private readonly CountryCollectionFactory $countryCollectionFactory,
        private readonly DirectoryHelper $directoryHelper,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /**
     * @return array{fields: array<int, array<string, mixed>>, countries: array<int, array<string, mixed>>, regions: array<string, array<int, array<string, mixed>>>}
     */
    public function forStore(int $storeId): array
    {
        return $this->forForm($storeId, self::ORDER_FORM_CODE);
    }

    /**
     * Frontend account-address metadata used by Magento's customer address
     * edit form, including store-specific visibility and required flags.
     *
     * @return array{fields: array<int, array<string, mixed>>, countries: array<int, array<string, mixed>>, regions: array<string, array<int, array<string, mixed>>>}
     */
    public function forCustomerAccount(int $storeId): array
    {
        return $this->forForm($storeId, self::CUSTOMER_ACCOUNT_FORM_CODE);
    }

    /** @return array<string, mixed> */
    private function forForm(int $storeId, string $formCode): array
    {
        $cacheKey = $storeId . ':' . $formCode;
        if (isset($this->cache[$cacheKey])) {
            return $this->cache[$cacheKey];
        }

        $currentStoreId = (int)$this->storeManager->getStore()->getId();
        try {
            if ($currentStoreId !== $storeId) {
                $this->storeManager->setCurrentStore($storeId);
            }

            $form = $this->customerFormFactory->create('customer_address', $formCode);
            $attributes = $form->getAttributes();
            uasort(
                $attributes,
                static fn ($left, $right): int => $left->getSortOrder() <=> $right->getSortOrder()
            );

            $fields = [];
            foreach ($attributes as $attribute) {
                $code = (string)$attribute->getAttributeCode();
                $inputType = (string)$attribute->getFrontendInput();
                if (!$attribute->isVisible()
                    || !in_array($code, self::ORDER_ADDRESS_FIELDS, true)
                    || $inputType === ''
                    || $inputType === 'hidden'
                ) {
                    continue;
                }

                $fields[] = [
                    'code' => $code,
                    'label' => (string)$attribute->getStoreLabel(),
                    'input_type' => $inputType,
                    'required' => (bool)$attribute->isRequired(),
                    'line_count' => $code === 'street'
                        ? max(1, min((int)$attribute->getMultilineCount(), 4))
                        : 1,
                ];
            }

            // This is the same data source consumed by Magento Checkout's
            // directoryRegionUpdater: allowed countries, per-country regions,
            // required states and optional postcodes.
            $directoryData = $this->directoryHelper->getRegionData();
            $regions = [];
            foreach ($directoryData as $countryId => $countryRegions) {
                if ($countryId === 'config' || !is_array($countryRegions)) {
                    continue;
                }
                foreach ($countryRegions as $regionId => $region) {
                    $id = (int)$regionId;
                    if ($id < 1 || !is_array($region)) {
                        continue;
                    }
                    $regions[(string)$countryId][] = [
                        'id' => $id,
                        'code' => (string)($region['code'] ?? ''),
                        'name' => (string)($region['name'] ?? ''),
                    ];
                }
            }

            $countries = [];
            foreach ($this->countryCollectionFactory->create()->loadByStore($storeId)->toOptionArray() as $country) {
                $value = strtoupper(trim((string)($country['value'] ?? '')));
                if ($value === '') {
                    continue;
                }
                $countries[] = [
                    'value' => $value,
                    'label' => (string)($country['label'] ?? $value),
                    'is_region_required' => $this->directoryHelper->isRegionRequired($value),
                    'is_zip_required' => !$this->directoryHelper->isZipCodeOptional($value),
                ];
            }

            return $this->cache[$cacheKey] = [
                'fields' => $fields,
                'countries' => $countries,
                'regions' => $regions,
            ];
        } finally {
            if ($currentStoreId !== $storeId) {
                $this->storeManager->setCurrentStore($currentStoreId);
            }
        }
    }

    /** @return string[] */
    public function editableCodes(int $storeId): array
    {
        $codes = array_column($this->forStore($storeId)['fields'], 'code');
        if (in_array('region', $codes, true)) {
            // Magento Admin displays region through a visible `region` field
            // while keeping the selected region ID in a companion field.
            $codes[] = 'region_id';
        }

        return $codes;
    }

    /** @return string[] */
    public function requiredCodes(int $storeId): array
    {
        return array_values(array_map(
            static fn (array $field): string => (string)$field['code'],
            array_filter(
                $this->forStore($storeId)['fields'],
                static fn (array $field): bool => !empty($field['required'])
            )
        ));
    }

    /** @return string[] */
    public function customerAccountRequiredCodes(int $storeId): array
    {
        return array_values(array_map(
            static fn (array $field): string => (string)$field['code'],
            array_filter(
                $this->forCustomerAccount($storeId)['fields'],
                static fn (array $field): bool => !empty($field['required'])
            )
        ));
    }

    public function isZipRequired(int $storeId, string $countryId): bool
    {
        $countryId = strtoupper(trim($countryId));
        foreach ($this->forStore($storeId)['countries'] as $country) {
            if (($country['value'] ?? '') === $countryId) {
                return !empty($country['is_zip_required']);
            }
        }

        return true;
    }

    public function isRegionRequired(int $storeId, string $countryId): bool
    {
        $countryId = strtoupper(trim($countryId));
        foreach ($this->forStore($storeId)['countries'] as $country) {
            if (($country['value'] ?? '') === $countryId) {
                return !empty($country['is_region_required']);
            }
        }

        return false;
    }

    public function hasRegions(int $storeId, string $countryId): bool
    {
        $regions = $this->forStore($storeId)['regions'][strtoupper(trim($countryId))] ?? [];

        return $regions !== [];
    }

    /** @param array<string, mixed> $changes @return array<string, mixed> */
    public function filterEditableChanges(array $changes, int $storeId): array
    {
        $allowed = array_flip($this->editableCodes($storeId));

        return array_intersect_key($changes, $allowed);
    }

    /** @param array<string, mixed> $changes @return array<string, mixed> */
    public function filterCustomerAccountEditableChanges(array $changes, int $storeId): array
    {
        $allowed = array_flip(array_column($this->forCustomerAccount($storeId)['fields'], 'code'));
        if (isset($allowed['region'])) {
            $allowed['region_id'] = true;
        }

        return array_intersect_key($changes, $allowed);
    }
}
