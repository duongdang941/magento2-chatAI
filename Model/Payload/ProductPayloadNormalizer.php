<?php
declare(strict_types=1);

namespace Afd\AI\Model\Payload;

use Afd\AI\Api\ProductRendererInterface;
use Magento\CatalogUrlRewrite\Model\ProductUrlRewriteGenerator;
use Magento\Framework\UrlInterface;
use Magento\Store\Model\StoreManagerInterface;
use Magento\UrlRewrite\Model\UrlFinderInterface;
use Magento\UrlRewrite\Service\V1\Data\UrlRewrite;

class ProductPayloadNormalizer
{
    private const MAX_LEGACY_PRODUCT_CARDS = 10;

    public function __construct(
        private readonly ProductRendererInterface $productRenderer,
        private readonly UrlFinderInterface $urlFinder,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /**
     * Normalize legacy gateway output to one shopper-facing result set.
     *
     * Every part keeps its original authoring position: a products part is
     * appended as encountered and only a pagination continuation of the most
     * recent products part is folded into that part's payload.
     *
     * @param array<int, array<string, mixed>> $parts
     * @return array<int, array<string, mixed>>
     */
    public function mergeSequentialProductParts(array $parts): array
    {
        $mergedParts = [];
        $openProductPartIndex = null;

        foreach ($parts as $part) {
            $payload = $part['type'] === 'products' && is_array($part['payload'] ?? null)
                ? $part['payload']
                : null;
            if ($payload === null) {
                $mergedParts[] = $part;
                continue;
            }

            $currentPayload = $openProductPartIndex !== null
                && is_array($mergedParts[$openProductPartIndex]['payload'] ?? null)
                ? $mergedParts[$openProductPartIndex]['payload']
                : null;
            if ($currentPayload !== null && $this->isNextProductPage($currentPayload, $payload)) {
                $combinedPayload = $this->mergeProductPayloadPages($currentPayload, $payload);
                $renderedHtml = $this->renderProductPayload($combinedPayload);
                $mergedParts[$openProductPartIndex]['payload'] = $combinedPayload;
                if ($renderedHtml !== '') {
                    $mergedParts[$openProductPartIndex]['html'] = $renderedHtml;
                }
                continue;
            }

            $mergedParts[] = $part;
            $openProductPartIndex = count($mergedParts) - 1;
        }

        return $mergedParts;
    }

    /** @param array<int, array<string, mixed>> $parts */
    public function hasProductPart(array $parts): bool
    {
        foreach ($parts as $part) {
            if (($part['type'] ?? '') === 'products' && trim((string)($part['html'] ?? '')) !== '') {
                return true;
            }
        }

        return false;
    }

    /**
     * Legacy assistant rows from older gateway versions may have only prose
     * containing verified Magento product links.
     *
     * @return array<string, mixed>|null
     */
    public function recoverLegacyProductGrid(string $content, string $messageId): ?array
    {
        if ($content === ''
            || preg_match_all('~\[[^\]\r\n]{1,255}\]\(([^\s)]+)\)~u', $content, $matches) < 1
        ) {
            return null;
        }

        try {
            $store = $this->storeManager->getStore();
            $storeId = (int)$store->getId();
            $storeHost = strtolower((string)parse_url((string)$store->getBaseUrl(), PHP_URL_HOST));
        } catch (\Throwable) {
            return null;
        }

        if ($storeId < 1 || $storeHost === '') {
            return null;
        }

        $productIds = [];
        foreach (array_slice($matches[1], 0, self::MAX_LEGACY_PRODUCT_CARDS * 2) as $candidate) {
            $parsed = parse_url(html_entity_decode((string)$candidate, ENT_QUOTES, 'UTF-8'));
            if (!is_array($parsed)) {
                continue;
            }
            $host = strtolower((string)($parsed['host'] ?? ''));
            if ($host !== '' && !hash_equals($storeHost, $host)) {
                continue;
            }
            $path = rawurldecode(ltrim((string)($parsed['path'] ?? ''), '/'));
            if ($path === '' || strlen($path) > 255 || str_contains($path, '..')) {
                continue;
            }

            $rewrite = $this->urlFinder->findOneByData([
                UrlRewrite::REQUEST_PATH => $path,
                UrlRewrite::STORE_ID => $storeId,
                UrlRewrite::ENTITY_TYPE => ProductUrlRewriteGenerator::ENTITY_TYPE,
                UrlRewrite::REDIRECT_TYPE => 0,
            ]);
            $productId = $rewrite ? (int)$rewrite->getEntityId() : 0;
            if ($productId > 0) {
                $productIds[$productId] = $productId;
            }
            if (count($productIds) >= self::MAX_LEGACY_PRODUCT_CARDS) {
                break;
            }
        }

        if ($productIds === []) {
            return null;
        }

        $html = $this->productRenderer->renderProducts(implode(',', $productIds));
        if (trim($html) === '') {
            return null;
        }

        return [
            'id' => $messageId !== '' ? $messageId . '-legacy-products' : 'legacy-products',
            'type' => 'products',
            'html' => $html,
            'payload' => [
                'contract_version' => 2,
                'kind' => 'product_list',
                'product_ids' => array_values($productIds),
                'items' => [],
                'total' => count($productIds),
                'coverage' => [
                    'shown' => count($productIds),
                    'total' => count($productIds),
                    'remaining' => 0,
                    'complete' => true,
                ],
                'pagination' => [
                    'page' => 1,
                    'page_size' => count($productIds),
                    'total' => count($productIds),
                    'returned' => count($productIds),
                    'has_more' => false,
                    'next_page' => null,
                    'can_load_more' => false,
                    'chat_card_limit' => self::MAX_LEGACY_PRODUCT_CARDS,
                    'truncated_for_chat' => false,
                ],
            ],
        ];
    }

    /** @param array<string, mixed> $existing @param array<string, mixed> $incoming */
    public function isNextProductPage(array $existing, array $incoming): bool
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
    public function mergeProductPayloadPages(array $existing, array $incoming): array
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

    public function normalizeProductPayload(mixed $payload): ?array
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

        return $normalizedPayload;
    }

    /** @return array<string, int|bool|null>|null */
    public function normalizeProductPagination(mixed $pagination): ?array
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
    public function normalizeProductScope(mixed $scope): ?array
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
     * @return array<int, array{code: string, label: string, values: array<int, string>}>
     */
    public function normalizeVariantOptions(mixed $options): array
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

    public function renderProductPayload(array $payload): string
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