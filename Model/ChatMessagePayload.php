<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ProductRendererInterface;

class ChatMessagePayload
{
    /** @var string[] */
    private const ORDER_ADDRESS_FIELDS = [
        'prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company',
        'street', 'city', 'region', 'region_id', 'postcode', 'country_id',
        'telephone', 'fax', 'vat_id',
    ];

    public function __construct(
        private readonly ProductRendererInterface $productRenderer
    ) {
    }

    /**
     * Build a structured assistant payload so text and product cards survive history reloads.
     *
     * @param array<int, array<string, mixed>> $parts
     */
    public function encodeAssistantParts(array $parts, array $metadata = []): string
    {
        $normalizedParts = [];

        foreach ($parts as $part) {
            $type = (string)($part['type'] ?? 'text');

            if ($type === 'products') {
                $payload = $this->normalizeProductPayload($part['payload'] ?? null);
                $html = trim((string)($part['html'] ?? ''));

                if ($payload !== null || $html !== '') {
                    $normalizedPart = ['type' => 'products'];
                    if ($payload !== null) {
                        $normalizedPart['payload'] = $payload;
                    } elseif ($html !== '') {
                        $normalizedPart['html'] = $html;
                    }
                    $normalizedParts[] = $normalizedPart;
                }
                continue;
            }

            if ($type === 'image') {
                $imagePart = $this->normalizeGeneratedImagePart($part);
                if ($imagePart !== null) {
                    $normalizedParts[] = $imagePart;
                }
                continue;
            }

            // Persist only the public form deadline. Email addresses, codes,
            // verification tokens and runtime state never enter chat history.
            if ($type === 'guest_order_access') {
                $accessPart = [
                    'type' => 'guest_order_access',
                    'purpose' => ($part['purpose'] ?? '') === 'support' ? 'support' : 'order'
                ];
                $expiresAt = max(0, (int)($part['expires_at'] ?? $part['expiresAt'] ?? 0));
                if ($expiresAt > 0) {
                    $accessPart['expires_at'] = $expiresAt;
                }
                $normalizedParts[] = $accessPart;
                continue;
            }

            if ($type === 'order_address_form') {
                $addressForm = $this->normalizeOrderAddressFormPart($part);
                if ($addressForm !== null) {
                    $normalizedParts[] = $addressForm;
                }
                continue;
            }

            $raw = (string)($part['raw'] ?? $part['text'] ?? '');
            if ($raw !== '') {
                $normalizedParts[] = [
                    'type' => 'text',
                    'raw' => $raw
                ];
            }
        }

        if ($normalizedParts === []) {
            return '';
        }

        $payload = [
            'version' => 1,
            'format' => 'afd_ai_chat_message',
            'text' => $this->extractTextFromParts($normalizedParts),
            'parts' => $normalizedParts
        ];

        if (($metadata['interrupted'] ?? false) === true) {
            $payload['interrupted'] = true;
            $payload['stopped_after_seconds'] = max(0, (int)($metadata['stopped_after_seconds'] ?? 0));
        }
        if (($metadata['source'] ?? '') === 'support_agent') {
            $payload['source'] = 'support_agent';
            $payload['sender_label'] = mb_substr(trim((string)($metadata['sender_label'] ?? 'Support team')), 0, 80);
            $payload['admin_id'] = max(0, (int)($metadata['admin_id'] ?? 0));
        }

        return (string)json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
    }

    /**
     * @return array{content:string,parts:array<int,array<string,mixed>>,interrupted:bool,stopped_after_seconds:int|null}
     */
    public function decodeStoredMessage(string $role, string $content, string $messageId = ''): array
    {
        $fallback = [
            'content' => $content,
            'parts' => [[
                'id' => $messageId !== '' ? $messageId . '-0' : '0',
                'type' => 'text',
                'raw' => $content,
                'html' => $content
            ]],
            'interrupted' => false,
            'stopped_after_seconds' => null,
            'source' => '',
            'sender_label' => '',
            'admin_id' => 0
        ];

        if ($role !== 'assistant') {
            return $fallback;
        }

        $decoded = json_decode($content, true);
        if (!is_array($decoded) || !isset($decoded['parts']) || !is_array($decoded['parts'])) {
            return $fallback;
        }

        $parts = [];

        foreach ($decoded['parts'] as $index => $part) {
            if (!is_array($part)) {
                continue;
            }

            $type = (string)($part['type'] ?? 'text');
            $partId = $messageId !== '' ? $messageId . '-' . $index : (string)$index;

            if ($type === 'products') {
                $payload = $this->normalizeProductPayload($part['payload'] ?? null);
                $html = $payload !== null
                    ? $this->renderProductPayload($payload)
                    : trim((string)($part['html'] ?? ''));
                if ($html !== '') {
                    $productPart = [
                        'id' => $partId,
                        'type' => 'products',
                        'html' => $html
                    ];
                    if ($payload !== null) {
                        $productPart['payload'] = $payload;
                    }
                    $parts[] = $productPart;
                }
                continue;
            }

            if ($type === 'image') {
                $imagePart = $this->normalizeGeneratedImagePart($part);
                if ($imagePart !== null) {
                    $imagePart['id'] = $partId;
                    $parts[] = $imagePart;
                }
                continue;
            }

            // Restore the public deadline so the form cannot gain another
            // fifteen minutes on reload. Sensitive OTP data is never returned.
            if ($type === 'guest_order_access') {
                $accessPart = [
                    'id' => $partId,
                    'type' => 'guest_order_access',
                    'purpose' => ($part['purpose'] ?? '') === 'support' ? 'support' : 'order'
                ];
                $expiresAt = max(0, (int)($part['expires_at'] ?? 0));
                if ($expiresAt > 0) {
                    $accessPart['expires_at'] = $expiresAt;
                }
                $parts[] = $accessPart;
                continue;
            }

            if ($type === 'order_address_form') {
                $addressForm = $this->normalizeOrderAddressFormPart($part);
                if ($addressForm !== null) {
                    $addressForm['id'] = $partId;
                    $parts[] = $addressForm;
                }
                continue;
            }

            $raw = (string)($part['raw'] ?? $part['text'] ?? '');
            $parts[] = [
                'id' => $partId,
                'type' => 'text',
                'raw' => $raw,
                'html' => $raw
            ];
        }

        if ($parts === []) {
            return $fallback;
        }

        $parts = $this->mergeSequentialProductParts($parts);

        $interrupted = ($decoded['interrupted'] ?? false) === true;

        return [
            'content' => isset($decoded['text']) && is_string($decoded['text'])
                ? $decoded['text']
                : $this->extractTextFromParts($parts),
            'parts' => $parts,
            'interrupted' => $interrupted,
            'stopped_after_seconds' => $interrupted
                ? max(0, (int)($decoded['stopped_after_seconds'] ?? 0))
                : null,
            'source' => ($decoded['source'] ?? '') === 'support_agent' ? 'support_agent' : '',
            'sender_label' => ($decoded['source'] ?? '') === 'support_agent'
                ? mb_substr(trim((string)($decoded['sender_label'] ?? 'Support team')), 0, 80)
                : '',
            'admin_id' => ($decoded['source'] ?? '') === 'support_agent'
                ? max(0, (int)($decoded['admin_id'] ?? 0))
                : 0
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $parts
     */
    public function extractTextFromParts(array $parts): string
    {
        $textParts = [];

        foreach ($parts as $part) {
            $type = (string)($part['type'] ?? 'text');
            if ($type !== 'text') {
                continue;
            }

            $raw = trim((string)($part['raw'] ?? $part['text'] ?? ''));
            if ($raw !== '') {
                $textParts[] = $raw;
            }
        }

        return implode("\n\n", $textParts);
    }

    /**
     * The gateway persists the current Magento address only as a short-lived
     * visual snapshot. This is never an authorization record; saving still
     * revalidates the order owner, shipment state and guest verification.
     *
     * @param array<string, mixed> $part
     * @return array<string, mixed>|null
     */
    private function normalizeOrderAddressFormPart(array $part): ?array
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
            // An expired card remains in history for context, but the address
            // values must not be sent back to the storefront. The frontend
            // renders this blank schema beneath its expiry overlay.
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
    private function normalizeOrderAddress(mixed $source): ?array
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
    private function normalizeOrderAddressFields(mixed $source): array
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
    private function normalizeOrderAddressCountries(mixed $source): array
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
    private function normalizeOrderAddressRegions(mixed $source): array
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

    /**
     * Generated images are stored as public Magento media URLs, never image
     * bytes. Keeping this validation central means every history endpoint
     * exposes the same safe structured part to the storefront.
     *
     * @param array<string, mixed> $part
     * @return array{type:string,url:string,alt:string,prompt:string,size:string,quality:string}|null
     */
    private function normalizeGeneratedImagePart(array $part): ?array
    {
        $url = trim((string)($part['url'] ?? ''));
        if (!preg_match('#^https?://#i', $url)) {
            return null;
        }

        return [
            'type' => 'image',
            'url' => $url,
            'alt' => mb_substr(trim((string)($part['alt'] ?? 'Generated image')) ?: 'Generated image', 0, 400),
            'prompt' => mb_substr(trim((string)($part['prompt'] ?? '')), 0, 4000),
            'size' => mb_substr(trim((string)($part['size'] ?? '')), 0, 32),
            'quality' => mb_substr(trim((string)($part['quality'] ?? '')), 0, 16),
        ];
    }

    /**
     * Normalize legacy gateway output to one shopper-facing result set. Later
     * pages extend the active set; a new page-one search replaces the previous
     * internal retrieval attempt.
     *
     * @param array<int, array<string, mixed>> $parts
     * @return array<int, array<string, mixed>>
     */
    private function mergeSequentialProductParts(array $parts): array
    {
        $mergedParts = [];
        $productPart = null;

        foreach ($parts as $part) {
            $payload = $part['type'] === 'products' && is_array($part['payload'] ?? null)
                ? $part['payload']
                : null;
            if ($payload === null) {
                $mergedParts[] = $part;
                continue;
            }

            if ($productPart === null) {
                $productPart = $part;
                continue;
            }

            $currentPayload = is_array($productPart['payload'] ?? null)
                ? $productPart['payload']
                : [];
            if ($this->isNextProductPage($currentPayload, $payload)) {
                $combinedPayload = $this->mergeProductPayloadPages($currentPayload, $payload);
                $productPart['payload'] = $combinedPayload;
                $productPart['html'] = $this->renderProductPayload($combinedPayload);
            } else {
                // Same-turn search refinement: only the final retrieval is a
                // presentation, earlier searches remain model evidence only.
                $productPart = $part;
            }
        }

        if ($productPart !== null) {
            $mergedParts[] = $productPart;
        }

        return $mergedParts;
    }

    /** @param array<string, mixed> $existing @param array<string, mixed> $incoming */
    private function isNextProductPage(array $existing, array $incoming): bool
    {
        $existingPage = max(1, (int)($existing['pagination']['page'] ?? 1));
        $incomingPage = max(1, (int)($incoming['pagination']['page'] ?? 1));
        if ($incomingPage <= $existingPage) {
            return false;
        }

        $existingCategoryId = (int)($existing['scope']['category_id'] ?? 0);
        $incomingCategoryId = (int)($incoming['scope']['category_id'] ?? 0);
        if ($existingCategoryId > 0 && $existingCategoryId === $incomingCategoryId) {
            return true;
        }

        $existingQuery = mb_strtolower(trim((string)($existing['query'] ?? '')));
        return $existingQuery !== ''
            && $existingQuery === mb_strtolower(trim((string)($incoming['query'] ?? '')));
    }

    /** @param array<string, mixed> $existing @param array<string, mixed> $incoming */
    private function mergeProductPayloadPages(array $existing, array $incoming): array
    {
        $items = [];
        $productIds = [];

        foreach ([$existing, $incoming] as $payload) {
            foreach ((array)($payload['product_ids'] ?? []) as $productId) {
                $id = (int)$productId;
                if ($id > 0) {
                    $productIds[$id] = $id;
                }
            }
            foreach ((array)($payload['items'] ?? []) as $item) {
                if (!is_array($item)) {
                    continue;
                }
                $id = (int)($item['id'] ?? 0);
                $serializedItem = (string)json_encode(
                    $item,
                    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
                );
                $key = $id > 0 ? 'id:' . $id : 'fallback:' . hash('sha256', $serializedItem);
                if (!isset($items[$key])) {
                    $items[$key] = $item;
                }
                if ($id > 0) {
                    $productIds[$id] = $id;
                }
            }
        }

        $combined = array_replace_recursive($existing, $incoming);
        $combined['query'] = trim((string)($incoming['query'] ?? '')) ?: (string)($existing['query'] ?? '');
        $combined['product_ids'] = array_values($productIds);
        $combined['items'] = array_values($items);
        $combined['total'] = max(
            count($combined['items']),
            (int)($existing['total'] ?? 0),
            (int)($incoming['total'] ?? 0),
            (int)($existing['pagination']['total'] ?? 0),
            (int)($incoming['pagination']['total'] ?? 0)
        );

        $pagination = array_replace(
            is_array($existing['pagination'] ?? null) ? $existing['pagination'] : [],
            is_array($incoming['pagination'] ?? null) ? $incoming['pagination'] : []
        );
        if ($pagination !== []) {
            $hasMore = $combined['total'] > count($combined['items']);
            $pagination['page'] = max(
                (int)($existing['pagination']['page'] ?? 1),
                (int)($incoming['pagination']['page'] ?? 1)
            );
            $pagination['total'] = $combined['total'];
            $pagination['returned'] = count($combined['items']);
            $pagination['has_more'] = $hasMore;
            $pagination['next_page'] = $hasMore ? $pagination['page'] + 1 : null;
            $combined['pagination'] = $pagination;
        }

        return $combined;
    }

    private function normalizeProductPayload(mixed $payload): ?array
    {
        if (!is_array($payload)) {
            return null;
        }

        $contractVersion = max(1, min(2, (int)($payload['contract_version'] ?? 1)));
        $rawProductIds = array_values(array_unique(array_filter(array_map(
            'intval',
            is_array($payload['product_ids'] ?? null) ? $payload['product_ids'] : []
        ))));
        $rawItems = array_values(array_filter(
            (array)($payload['items'] ?? []),
            'is_array'
        ));
        $legacyExactTotal = max(count($rawProductIds), count($rawItems));
        $pagination = $this->normalizeProductPagination($payload['pagination'] ?? null);
        $visibleLimit = $pagination !== null
            ? min(
                (int)$pagination['chat_card_limit'],
                (int)$pagination['page'] * (int)$pagination['page_size']
            )
            : 20;

        $productIds = array_slice($rawProductIds, 0, $visibleLimit);

        $items = [];
        foreach (array_slice($rawItems, 0, $visibleLimit) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $normalizedItem = [
                'id' => isset($item['id']) ? (int)$item['id'] : 0,
                'sku' => (string)($item['sku'] ?? ''),
                'name' => (string)($item['name'] ?? ''),
                'price' => (string)($item['price'] ?? ''),
                'url' => (string)($item['url'] ?? ''),
                'in_stock' => (string)($item['in_stock'] ?? ''),
                'product_type' => (string)($item['product_type'] ?? ''),
                'requires_variant_selection' => (bool)($item['requires_variant_selection'] ?? false),
                'variant_options' => $this->normalizeVariantOptions($item['variant_options'] ?? [])
            ];

            if ($normalizedItem['id'] > 0) {
                $productIds[] = $normalizedItem['id'];
            }

            $items[] = $normalizedItem;
        }

        $productIds = array_slice(
            array_values(array_unique(array_filter($productIds))),
            0,
            $visibleLimit
        );
        if ($productIds === [] && $items === []) {
            return null;
        }

        $normalizedPayload = [
            'contract_version' => $contractVersion,
            'kind' => 'product_list',
            'query' => (string)($payload['query'] ?? ''),
            'product_ids' => $productIds,
            'items' => $items,
            'total' => $contractVersion < 2
                ? $legacyExactTotal
                : (isset($payload['total']) ? (int)$payload['total'] : count($productIds))
        ];

        if ($pagination !== null) {
            if ($contractVersion < 2) {
                $pagination['total'] = $legacyExactTotal;
                $pagination['has_more'] = (
                    (int)$pagination['page'] * (int)$pagination['page_size']
                ) < $legacyExactTotal;
                $pagination['next_page'] = $pagination['has_more']
                    ? (int)$pagination['page'] + 1
                    : null;
            }
            $pagination['returned'] = count($items);
            $normalizedPayload['pagination'] = $pagination;
        }

        $scope = $this->normalizeProductScope($payload['scope'] ?? null);
        if ($scope !== null) {
            $normalizedPayload['scope'] = $scope;
        }

        // Continuation tokens are intentionally transient. The authenticated
        // Node gateway issues a fresh token from this safe pagination contract
        // when it rehydrates a persisted conversation.
        return $normalizedPayload;
    }

    /** @return array<string, int|bool|null>|null */
    private function normalizeProductPagination(mixed $pagination): ?array
    {
        if (!is_array($pagination)) {
            return null;
        }

        $pageSize = max(1, min(10, (int)($pagination['page_size'] ?? 5)));
        $page = max(1, (int)($pagination['page'] ?? 1));
        $returned = max(0, (int)($pagination['returned'] ?? 0));
        $total = max($returned, (int)($pagination['total'] ?? 0));
        $hasMore = (bool)($pagination['has_more'] ?? false);

        return [
            'total' => $total,
            'page' => $page,
            'page_size' => $pageSize,
            'returned' => $returned,
            'has_more' => $hasMore,
            'next_page' => $hasMore ? max($page + 1, (int)($pagination['next_page'] ?? 0)) : null,
            'chat_card_limit' => max(1, min(100, (int)($pagination['chat_card_limit'] ?? 20))),
            'truncated_for_chat' => (bool)($pagination['truncated_for_chat'] ?? false),
        ];
    }

    /** @return array<string, int|string|bool|null>|null */
    private function normalizeProductScope(mixed $scope): ?array
    {
        if (!is_array($scope)) {
            return null;
        }

        $url = trim((string)($scope['category_url'] ?? ''));
        if ($url !== '' && !preg_match('#^(?:https?://|/)#i', $url)) {
            $url = '';
        }

        return [
            'category_id' => (int)($scope['category_id'] ?? 0) ?: null,
            'category_name' => mb_substr(trim((string)($scope['category_name'] ?? '')), 0, 255),
            'category_url' => $url,
            'includes_descendants' => (bool)($scope['includes_descendants'] ?? false),
            'direct_add_only' => (bool)($scope['direct_add_only'] ?? false),
        ];
    }

    /**
     * Preserve configurable dimensions without assuming project-specific
     * attribute codes such as colour, size, farbe or grosse.
     *
     * @return array<int, array{code: string, label: string, values: array<int, string>}>
     */
    private function normalizeVariantOptions(mixed $options): array
    {
        if (!is_array($options)) {
            return [];
        }

        $normalized = [];
        foreach ($options as $option) {
            if (!is_array($option)) {
                continue;
            }

            $values = array_values(array_filter(array_map(
                static fn (mixed $value): string => trim((string)$value),
                is_array($option['values'] ?? null) ? $option['values'] : []
            )));
            if ($values === []) {
                continue;
            }

            $normalized[] = [
                'code' => trim((string)($option['code'] ?? '')),
                'label' => trim((string)($option['label'] ?? '')),
                'values' => array_values(array_unique($values)),
            ];
        }

        return $normalized;
    }

    private function renderProductPayload(array $payload): string
    {
        $productIds = array_values(array_unique(array_filter(array_map(
            'intval',
            is_array($payload['product_ids'] ?? null) ? $payload['product_ids'] : []
        ))));

        if ($productIds === []) {
            return '';
        }

        return $this->productRenderer->renderProducts(implode(',', $productIds));
    }
}
