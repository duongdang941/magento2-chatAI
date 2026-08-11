<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Magento\Directory\Model\AllowedCountries;
use Magento\Directory\Model\CountryFactory;
use Magento\Directory\Model\RegionFactory;
use Magento\Framework\Exception\LocalizedException;
use Magento\Sales\Model\Order;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

/** Shared validation, normalization and presentation for sales-order address snapshots. */
class OrderAddressUpdater
{
    public function __construct(
        private readonly CountryFactory $countryFactory,
        private readonly RegionFactory $regionFactory,
        private readonly AllowedCountries $allowedCountries,
        private readonly StoreManagerInterface $storeManager,
        private readonly OrderAddressFormMetadata $addressFormMetadata
    ) {
    }

    /** @return array{allowed: bool, reason: string, message: string} */
    public function eligibility(Order $order): array
    {
        if ($order->hasShipments()) {
            return [
                'allowed' => false,
                'reason' => 'order_already_shipped',
                'message' => __('This order already has a shipment, so its address can no longer be changed.')->render(),
            ];
        }

        if ($order->isCanceled() || in_array((string)$order->getState(), [Order::STATE_COMPLETE, Order::STATE_CLOSED], true)) {
            return [
                'allowed' => false,
                'reason' => 'order_not_active',
                'message' => __('The address can only be changed on an active, unshipped order.')->render(),
            ];
        }

        return ['allowed' => true, 'reason' => '', 'message' => ''];
    }

    /** @param array<string, mixed> $changes */
    public function apply(mixed $address, array $changes, int $storeId): void
    {
        $changes = $this->addressFormMetadata->filterEditableChanges($changes, $storeId);
        $firstname = $this->stringValue($changes, 'firstname', (string)$address->getFirstname(), 64);
        $lastname = $this->stringValue($changes, 'lastname', (string)$address->getLastname(), 64);
        $city = $this->stringValue($changes, 'city', (string)$address->getCity(), 128);
        $postcode = $this->stringValue($changes, 'postcode', (string)$address->getPostcode(), 32);
        $telephone = $this->stringValue($changes, 'telephone', (string)$address->getTelephone(), 64);
        $countryId = strtoupper($this->stringValue($changes, 'country_id', (string)$address->getCountryId(), 2));
        $street = $this->streetValue($changes, $address->getStreet());

        $fieldValues = [
            'firstname' => $firstname,
            'lastname' => $lastname,
            'company' => $this->stringValue($changes, 'company', (string)$address->getCompany(), 128),
            'street' => $street,
            'city' => $city,
            'region' => $this->stringValue($changes, 'region', (string)$address->getRegion(), 128),
            'postcode' => $postcode,
            'country_id' => $countryId,
            'telephone' => $telephone,
            'fax' => $this->stringValue($changes, 'fax', (string)$address->getFax(), 64),
            'vat_id' => $this->stringValue($changes, 'vat_id', (string)$address->getVatId(), 64),
        ];
        foreach ($this->addressFormMetadata->requiredCodes($storeId) as $field) {
            $value = $fieldValues[$field] ?? '';
            if ($field === 'street' ? $value === [] : $value === '') {
                throw new LocalizedException(__('The %1 field is required.', $field));
            }
        }

        $this->validateCountryAndPostcode($countryId, $postcode, $street, $storeId);
        [$regionId, $region, $regionCode] = $this->resolveRegion($address, $changes, $countryId, $storeId);

        $address
            ->setPrefix($this->stringValue($changes, 'prefix', (string)$address->getPrefix(), 40))
            ->setFirstname($firstname)
            ->setMiddlename($this->stringValue($changes, 'middlename', (string)$address->getMiddlename(), 64))
            ->setLastname($lastname)
            ->setSuffix($this->stringValue($changes, 'suffix', (string)$address->getSuffix(), 40))
            ->setCompany($this->stringValue($changes, 'company', (string)$address->getCompany(), 128))
            ->setStreet($street)
            ->setCity($city)
            ->setPostcode($postcode)
            ->setTelephone($telephone)
            ->setFax($this->stringValue($changes, 'fax', (string)$address->getFax(), 64))
            ->setVatId($this->stringValue($changes, 'vat_id', (string)$address->getVatId(), 64))
            ->setCountryId($countryId)
            ->setRegion($region)
            ->setRegionId($regionId ?: null)
            ->setRegionCode($regionCode);
    }

    /** @return array<string, mixed>|null */
    public function format(mixed $address): ?array
    {
        if (!$address) {
            return null;
        }

        return [
            'prefix' => (string)$address->getPrefix(),
            'firstname' => (string)$address->getFirstname(),
            'middlename' => (string)$address->getMiddlename(),
            'lastname' => (string)$address->getLastname(),
            'suffix' => (string)$address->getSuffix(),
            'company' => (string)$address->getCompany(),
            'street' => $this->streetValue([], $address->getStreet()),
            'city' => (string)$address->getCity(),
            'region' => (string)$address->getRegion(),
            'region_id' => (int)$address->getRegionId(),
            'postcode' => (string)$address->getPostcode(),
            'country_id' => (string)$address->getCountryId(),
            'telephone' => (string)$address->getTelephone(),
            'fax' => (string)$address->getFax(),
            'vat_id' => (string)$address->getVatId(),
            'email' => (string)$address->getEmail(),
        ];
    }

    /** @param string[] $street */
    private function validateCountryAndPostcode(string $countryId, string $postcode, array $street, int $storeId): void
    {
        if (!preg_match('/^[A-Z]{2}$/', $countryId)) {
            throw new LocalizedException(__('Please provide a valid two-letter country code.'));
        }
        if ($street === []) {
            throw new LocalizedException(__('The street address is required.'));
        }
        if ($this->addressFormMetadata->isZipRequired($storeId, $countryId) && $postcode === '') {
            throw new LocalizedException(__('The postcode field is required for the selected country.'));
        }

        $country = $this->countryFactory->create()->loadByCode($countryId);
        if (!$country->getId()) {
            throw new LocalizedException(__('The selected country is not available.'));
        }

        $websiteId = (int)$this->storeManager->getStore($storeId)->getWebsiteId();
        $allowedCountries = array_filter(
            $this->allowedCountries->getAllowedCountries(ScopeInterface::SCOPE_WEBSITE, $websiteId)
        );
        if ($allowedCountries !== [] && !in_array($countryId, $allowedCountries, true)) {
            throw new LocalizedException(__('The selected country is not available for this store.'));
        }
    }

    /** @return array{0:int,1:string,2:string} */
    private function resolveRegion(mixed $address, array $changes, string $countryId, int $storeId): array
    {
        $countryChanged = $countryId !== strtoupper((string)$address->getCountryId());
        $hasRegionId = array_key_exists('region_id', $changes);
        $hasRegion = array_key_exists('region', $changes);
        $regionId = $hasRegionId
            ? (int)$changes['region_id']
            : (($hasRegion || $countryChanged) ? 0 : (int)$address->getRegionId());
        $region = $this->stringValue($changes, 'region', (string)$address->getRegion(), 128);

        if ($regionId > 0) {
            $regionModel = $this->regionFactory->create()->load($regionId);
            if (!$regionModel->getId() || strtoupper((string)$regionModel->getCountryId()) !== $countryId) {
                throw new LocalizedException(__('The selected region does not belong to the selected country.'));
            }
            $regionId = (int)$regionModel->getId();
            $region = (string)$regionModel->getName();
            $regionCode = (string)$regionModel->getCode();
        } elseif ($countryChanged) {
            $regionId = 0;
            if (!$hasRegion) {
                $region = '';
            }
            $regionCode = '';
        } else {
            $regionCode = $regionId > 0 ? (string)$address->getRegionCode() : '';
        }

        if ($this->addressFormMetadata->isRegionRequired($storeId, $countryId)) {
            if ($this->addressFormMetadata->hasRegions($storeId, $countryId) && $regionId < 1) {
                throw new LocalizedException(__('Please choose a state/province for the selected country.'));
            }
            if (!$this->addressFormMetadata->hasRegions($storeId, $countryId) && $region === '') {
                throw new LocalizedException(__('The state/province field is required for the selected country.'));
            }
        }

        return [$regionId, $region, $regionCode];
    }

    /** @param array<string, mixed> $values */
    private function stringValue(array $values, string $field, string $fallback, int $maxLength): string
    {
        $value = array_key_exists($field, $values) ? (string)$values[$field] : $fallback;
        return mb_substr(trim(preg_replace('/\s+/u', ' ', $value) ?? ''), 0, $maxLength);
    }

    /** @param array<string, mixed> $values @return string[] */
    private function streetValue(array $values, mixed $fallback): array
    {
        $source = array_key_exists('street', $values) ? $values['street'] : $fallback;
        $lines = is_array($source) ? $source : preg_split('/\R/u', (string)$source);
        $normalized = [];
        foreach (array_slice(is_array($lines) ? $lines : [], 0, 4) as $line) {
            $line = trim(preg_replace('/\s+/u', ' ', (string)$line) ?? '');
            if ($line !== '') {
                $normalized[] = mb_substr($line, 0, 255);
            }
        }
        return $normalized;
    }
}
