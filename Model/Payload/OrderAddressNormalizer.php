<?php
declare(strict_types=1);

namespace Afd\AI\Model\Payload;

class OrderAddressNormalizer
{
    /** @var string[] */
    private const ORDER_ADDRESS_FIELDS = [
        'prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company',
        'street', 'city', 'region', 'region_id', 'postcode', 'country_id',
        'telephone', 'fax', 'vat_id',
    ];

    /**
     * The gateway persists the current Magento address only as a short-lived
     * visual snapshot. This is never an authorization record; saving still
     * revalidates the order owner, shipment state and guest verification.
     *
     * @param array<string, mixed> $part
     * @return array<string, mixed>|null
     */
    public function normalizeOrderAddressFormPart(array $part): ?array
    {
        $formId = mb_substr(trim((string)($part['form_id'] ?? $part['formId'] ?? '')), 0, 160);
        $orderNumber = mb_substr(trim((string)($part['order_number'] ?? $part['orderNumber'] ?? '')), 0, 64);
        $resourceType = ($part['resource_type'] ?? $part['resourceType'] ?? '') === 'customer_account'
            ? 'customer_account'
            : 'order';
        if ($formId === '' || ($resourceType === 'order' && $orderNumber === '')) {
            return null;
        }

        $sourceAddresses = is_array($part['addresses'] ?? null) ? $part['addresses'] : [];
        $addresses = [
            'billing' => $this->normalizeOrderAddress($sourceAddresses['billing'] ?? null),
            'shipping' => $this->normalizeOrderAddress($sourceAddresses['shipping'] ?? null),
        ];
        $addressTypes = [];
        foreach ((array)($part['address_types'] ?? $part['addressTypes'] ?? []) as $type) {
            if (!in_array($type, ['billing', 'shipping'], true)
                || $addresses[$type] === null
                || in_array($type, $addressTypes, true)
            ) {
                continue;
            }
            $addressTypes[] = $type;
        }
        if ($addressTypes === []) {
            return null;
        }

        $requestedType = (string)($part['address_type'] ?? $part['addressType'] ?? '');
        $addressType = in_array($requestedType, $addressTypes, true)
            ? $requestedType
            : (in_array('shipping', $addressTypes, true) ? 'shipping' : 'billing');
        $createdAt = max(1, (int)($part['created_at'] ?? $part['createdAt'] ?? round(microtime(true) * 1000)));
        $expiresAt = max(
            $createdAt,
            (int)($part['expires_at'] ?? $part['expiresAt'] ?? ($createdAt + 900000))
        );
        if ($expiresAt <= (int)round(microtime(true) * 1000)) {
            foreach ($addressTypes as $type) {
                $addresses[$type] = [];
            }
        }

        return [
            'type' => 'order_address_form',
            'form_id' => $formId,
            'action_token' => mb_substr((string)($part['action_token'] ?? $part['actionToken'] ?? ''), 0, 2048),
            'created_at' => $createdAt,
            'expires_at' => $expiresAt,
            'access_scope' => ($part['access_scope'] ?? $part['accessScope'] ?? '') === 'customer'
                ? 'customer'
                : 'guest',
            'resource_type' => $resourceType,
            'order_number' => $orderNumber,
            'addresses' => $addresses,
            'address_types' => $addressTypes,
            'address_type' => $addressType,
            'fields' => $this->normalizeOrderAddressFields($part['fields'] ?? []),
            'countries' => $this->normalizeOrderAddressCountries($part['countries'] ?? []),
            'regions' => $this->normalizeOrderAddressRegions($part['regions'] ?? []),
        ];
    }

    /** @return array<string, mixed>|null */
    public function normalizeOrderAddress(mixed $source): ?array
    {
        if (!is_array($source)) {
            return null;
        }

        $address = [];
        foreach (self::ORDER_ADDRESS_FIELDS as $field) {
            if (!array_key_exists($field, $source)) {
                continue;
            }
            if ($field === 'street') {
                $street = is_array($source['street']) ? $source['street'] : preg_split('/\R/', (string)$source['street']);
                $address['street'] = array_map(
                    static fn (mixed $line): string => mb_substr((string)$line, 0, 255),
                    array_slice($street ?: [], 0, 4)
                );
                continue;
            }
            if ($field === 'region_id') {
                $address[$field] = max(0, (int)$source[$field]);
                continue;
            }
            $address[$field] = $field === 'country_id'
                ? strtoupper(trim((string)$source[$field]))
                : mb_substr((string)$source[$field], 0, 255);
        }

        return $address;
    }

    /** @return array<int, array<string, mixed>> */
    public function normalizeOrderAddressFields(mixed $source): array
    {
        if (!is_array($source)) {
            return [];
        }

        $fields = [];
        foreach ($source as $field) {
            if (!is_array($field)) {
                continue;
            }
            $code = trim((string)($field['code'] ?? ''));
            if (!in_array($code, self::ORDER_ADDRESS_FIELDS, true) || $code === 'region_id' || isset($fields[$code])) {
                continue;
            }
            $fields[$code] = [
                'code' => $code,
                'label' => mb_substr(trim((string)($field['label'] ?? $code)), 0, 120),
                'required' => !empty($field['required']),
                'line_count' => $code === 'street'
                    ? max(1, min((int)($field['line_count'] ?? $field['lineCount'] ?? 1), 4))
                    : 1,
            ];
        }

        return array_values($fields);
    }

    /** @return array<int, array<string, mixed>> */
    public function normalizeOrderAddressCountries(mixed $source): array
    {
        if (!is_array($source)) {
            return [];
        }

        $countries = [];
        foreach ($source as $country) {
            if (!is_array($country)) {
                continue;
            }
            $value = strtoupper(trim((string)($country['value'] ?? '')));
            if (!preg_match('/^[A-Z]{2}$/', $value) || isset($countries[$value])) {
                continue;
            }
            $countries[$value] = [
                'value' => $value,
                'label' => mb_substr(trim((string)($country['label'] ?? $value)), 0, 120),
                'is_region_required' => !empty($country['is_region_required'])
                    || !empty($country['isRegionRequired']),
                'is_zip_required' => ($country['is_zip_required'] ?? $country['isZipRequired'] ?? true) !== false,
            ];
        }

        return array_values($countries);
    }

    /** @return array<string, array<int, array<string, mixed>>> */
    public function normalizeOrderAddressRegions(mixed $source): array
    {
        if (!is_array($source)) {
            return [];
        }

        $regions = [];
        foreach ($source as $countryId => $countryRegions) {
            $country = strtoupper(trim((string)$countryId));
            if (!preg_match('/^[A-Z]{2}$/', $country) || !is_array($countryRegions)) {
                continue;
            }
            foreach ($countryRegions as $region) {
                if (!is_array($region)) {
                    continue;
                }
                $id = max(0, (int)($region['id'] ?? 0));
                $name = mb_substr(trim((string)($region['name'] ?? '')), 0, 120);
                if ($id < 1 || $name === '') {
                    continue;
                }
                $regions[$country][] = [
                    'id' => $id,
                    'code' => mb_substr(trim((string)($region['code'] ?? '')), 0, 32),
                    'name' => $name,
                ];
            }
        }

        return $regions;
    }
}