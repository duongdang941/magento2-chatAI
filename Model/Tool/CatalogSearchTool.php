<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Catalog\PriceConstraintConverter;
use Afd\AI\Model\Data\ToolResponseFactory;
use Afd\AI\Model\Product\CatalogIdentityMatcher;
use Afd\AI\Model\Product\DirectAddEligibility;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Magento\Catalog\Model\ResourceModel\Category\CollectionFactory as CategoryCollectionFactory;
use Magento\Catalog\Model\ResourceModel\Product\CollectionFactory as ProductCollectionFactory;
use Magento\CatalogInventory\Helper\Stock as StockHelper;
use Magento\Catalog\Pricing\Price\FinalPrice;
use Magento\Framework\Pricing\PriceCurrencyInterface;

/**
 * Authoritative, language-neutral catalogue retrieval for the AI agent.
 *
 * Intent detection, translation and query refinement belong to the model's
 * tool loop. This service only executes structured retrieval against the
 * active Magento search engine or a category ID returned by listCategories().
 * Keeping those responsibilities separate makes the module reusable by stores
 * with different catalogue languages, taxonomies and attribute sets.
 */
class CatalogSearchTool
{
    public function __construct(
        private readonly PriceCurrencyInterface $priceCurrency,
        private readonly ProductRendererInterface $productRenderer,
        private readonly ToolResponseFactory $toolResponseFactory,
        private readonly FulltextProductCollectionFactory $fulltextCollectionFactory,
        private readonly ProductCollectionFactory $productCollectionFactory,
        private readonly CategoryCollectionFactory $categoryCollectionFactory,
        private readonly StockHelper $stockHelper,
        private readonly DirectAddEligibility $directAddEligibility,
        private readonly SaleQuantityPolicy $saleQuantityPolicy,
        private readonly CatalogIdentityMatcher $catalogIdentityMatcher,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly CatalogVisibilityPolicyInterface $catalogVisibilityPolicy,
        private readonly PriceConstraintConverter $priceConstraintConverter
    ) {
    }

    /**
     * Search by an exact agent-provided query, or browse a verified category.
     *
     * The agent supplies price constraints as structured parameters. This is
     * deliberately not a natural-language parser: parsing shopper language in
     * PHP would reintroduce a project- and language-specific keyword list.
     */
    public function searchProducts(
        string $query,
        int $limit = 5,
        int $page = 1,
        int $categoryId = 0,
        float $minPrice = 0.0,
        float $maxPrice = 0.0,
        string $priceCurrency = '',
        bool $directAddOnly = false,
        bool $exactIdentity = false,
        string $excludedTerms = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ) {
        $query = trim($query);
        $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
        $excludedNameTerms = $this->normalizeExcludedTerms($excludedTerms);
        // Five is the presentation default at the gateway. Magento accepts up
        // to ten for an explicit “show me 10” request, but never an unbounded
        // category dump.
        $limit = max(1, min(10, $limit));
        $page = max(1, $page);
        $categoryIds = $categoryId > 0 ? $this->expandCategoryIdsWithDescendants([$categoryId], $shopperScope) : [];
        $categoryScope = $categoryId > 0 ? $this->getCategoryScope($categoryId, $shopperScope) : [];
        $priceConstraints = $this->priceConstraintConverter->convert($minPrice, $maxPrice, $priceCurrency);
        $minPrice = $priceConstraints['min_price'];
        $maxPrice = $priceConstraints['max_price'];

        if (!$priceConstraints['available']) {
            return $this->emptyResponse($page, $limit, $shopperScope, $categoryScope, $priceConstraints['meta']);
        }

        // A broad, unconstrained product dump is neither useful to the agent
        // nor safe for catalogue cost. The protocol requires listCategories()
        // first, then an explicit categoryId for category browsing.
        if ($query === '' && $categoryIds === [] && $minPrice <= 0 && $maxPrice <= 0) {
            return $this->emptyResponse($page, $limit, $shopperScope, $categoryScope, $priceConstraints['meta']);
        }

        // Resolve the complete fulltext ID set once so stock, price and
        // direct-add SQL filters can produce an exact total. Magento's normal
        // setPageSize() no longer applies after that render step, therefore
        // the final page boundary must be placed directly on the SQL select.
        $collection = $this->createFilteredProductCollection(
            $query,
            $categoryIds,
            $minPrice,
            $maxPrice,
            $directAddOnly,
            $excludedNameTerms,
            $shopperScope
        );
        $totalResults = $this->getFilteredCollectionSize($collection);
        $collection->clear();
        $collection->getSelect()->limitPage($page, $limit);

        [$resultData, $productIds] = $this->collectProductResults($collection, $shopperScope);
        if ($exactIdentity) {
            [$resultData, $productIds] = $this->filterPresentedIdentityMatches(
                $query,
                $resultData,
                $productIds
            );
            if ($resultData !== []) {
                $totalResults = count($resultData);
            }
        }
        $activeIdentityDistance = $this->bestPresentedProductIdentityDistance($query, $resultData);
        // Fulltext engines commonly return no row for a one-character typo.
        // The bounded identity fallback is safe for every non-empty query:
        // its matcher rejects short broad facets and requires all meaningful
        // query tokens to map to one product name. Do not make recovery depend
        // on the model setting exactIdentity correctly.
        if ($resultData === [] && $activeIdentityDistance === null && $query !== '') {
            [$resultData, $productIds] = $this->findActiveIdentityFallback(
                $query,
                $excludedNameTerms,
                $shopperScope
            );
            if ($resultData !== []) {
                $totalResults = count($resultData);
            }
            $activeIdentityDistance = $this->bestPresentedProductIdentityDistance($query, $resultData);
        }
        $disabledIdentityDistance = $query !== ''
            ? $this->bestUnavailableProductIdentityDistance($query, $shopperScope)
            : null;
        $unavailableQueryMatch = $disabledIdentityDistance !== null
            && ($activeIdentityDistance === null || $disabledIdentityDistance < $activeIdentityDistance);
        $exactQueryMiss = $exactIdentity && $activeIdentityDistance === null;
        if ($unavailableQueryMatch || $exactQueryMiss) {
            // A disabled identity is closer than every active result. Do not
            // publish similar active cards: they are evidence for the model,
            // not a valid substitute for the explicitly requested product.
            $resultData = [];
            $productIds = [];
            $totalResults = 0;
        }
        $html = $productIds !== []
            ? $this->productRenderer->renderProducts(
                implode(',', $productIds),
                $shopperScope->getCustomerGroupId(),
                $customerId
            )
            : '';

        $response = $this->toolResponseFactory->create();
        $response->setData($resultData);
        $response->setHtml($html);
        $response->setMeta([
            'pagination' => [
                'total' => $totalResults,
                'page' => $page,
                'page_size' => $limit,
                'returned' => count($resultData),
                'has_more' => ($page * $limit) < $totalResults,
                'next_page' => ($page * $limit) < $totalResults ? $page + 1 : null,
            ],
            'scope' => [
                ...$shopperScope->toArray(),
                ...$categoryScope,
                'category_id' => $categoryId > 0 ? $categoryId : null,
                'includes_descendants' => $categoryId > 0,
                'direct_add_only' => $directAddOnly,
                'exact_identity' => $exactIdentity,
                'exact_query_match' => $exactIdentity && $activeIdentityDistance !== null,
                'exact_query_miss' => $exactQueryMiss,
                'excluded_terms' => $excludedNameTerms,
                'unavailable_query_match' => $unavailableQueryMatch,
            ],
            'currency' => $priceConstraints['meta'],
        ]);

        return $response;
    }

    /** @param array<string, mixed> $currencyMeta */
    private function emptyResponse(
        int $page,
        int $limit,
        ShopperScope $shopperScope,
        array $categoryScope,
        array $currencyMeta
    ) {
        $response = $this->toolResponseFactory->create();
        $response->setData([]);
        $response->setHtml('');
        $response->setMeta([
            'pagination' => [
                'total' => 0,
                'page' => $page,
                'page_size' => $limit,
                'returned' => 0,
                'has_more' => false,
                'next_page' => null,
            ],
            'scope' => [...$shopperScope->toArray(), ...$categoryScope],
            'currency' => $currencyMeta,
        ]);

        return $response;
    }

    /**
     * Build the same filtered collection for exact counting and page loading.
     *
     * @param int[] $categoryIds
     * @param string[] $excludedNameTerms
     */
    private function createFilteredProductCollection(
        string $query,
        array $categoryIds,
        float $minPrice,
        float $maxPrice,
        bool $directAddOnly,
        array $excludedNameTerms,
        ShopperScope $shopperScope
    ) {
        // A non-empty query remains a hard product-type constraint even after
        // the agent narrows retrieval to a verified category. Using a plain
        // category collection here used to discard the query and could turn a
        // request for one product type into an unrelated category dump.
        $collection = $query !== ''
            ? $this->createSearchProductCollection($query, $shopperScope)
            : $this->createCategoryProductCollection($shopperScope);

        if ($categoryIds !== []) {
            $collection->addCategoriesFilter(['in' => $categoryIds]);
        }

        $this->applyAvailabilityAndPriceFilters($collection, $minPrice, $maxPrice);
        $this->applyExcludedNameTerms($collection, $excludedNameTerms);
        if ($directAddOnly) {
            $this->applyDirectAddOnlyFilter($collection);
        }

        return $collection;
    }

    /**
     * Return the count after stock, price and direct-add SQL filters.
     *
     * FulltextCollection::getSize() exposes the search-engine total before
     * those SQL filters. Triggering it is still required to apply the search
     * result IDs, then the SQL count select supplies the truthful total.
     */
    private function getFilteredCollectionSize($collection): int
    {
        $collection->getSize();

        return (int)$collection->getConnection()->fetchOne(
            $collection->getSelectCountSql()
        );
    }

    private function createSearchProductCollection(string $query, ShopperScope $shopperScope)
    {
        $collection = $this->fulltextCollectionFactory->create();
        $this->configureProductCollection($collection, $shopperScope);

        if ($query !== '') {
            $collection->addSearchFilter($query);
        }

        return $collection;
    }

    private function createCategoryProductCollection(ShopperScope $shopperScope)
    {
        $collection = $this->productCollectionFactory->create();
        $this->configureProductCollection($collection, $shopperScope);

        return $collection;
    }

    private function configureProductCollection($collection, ShopperScope $shopperScope): void
    {
        $this->catalogVisibilityPolicy->applyToProductCollection($collection, $shopperScope);
        $collection->addAttributeToSelect([
            'name',
            'sku',
            'price',
            'special_price',
            'special_from_date',
            'special_to_date',
            'small_image',
            'thumbnail',
            'image',
            'url_key',
            'type_id',
            'required_options',
        ]);
        $collection->addAttributeToFilter('type_id', [
            'in' => ['simple', 'configurable'],
        ]);
        $collection->addUrlRewrite();
        $this->applyInternalProductFilters($collection);
    }

    private function applyAvailabilityAndPriceFilters($collection, float $minPrice, float $maxPrice): void
    {
        $this->stockHelper->addInStockFilterToCollection($collection);

        if ($minPrice > 0) {
            $collection->getSelect()->where('price_index.final_price >= ?', $minPrice);
        }
        if ($maxPrice > 0) {
            $collection->getSelect()->where('price_index.final_price <= ?', $maxPrice);
        }
        if ($minPrice > 0 || $maxPrice > 0) {
            $collection->getSelect()->order('price_index.final_price ASC');
        }
    }

    /** @param string[] $excludedNameTerms */
    private function applyExcludedNameTerms($collection, array $excludedNameTerms): void
    {
        foreach ($excludedNameTerms as $term) {
            $collection->addAttributeToFilter('name', ['nlike' => '%' . $term . '%']);
        }
    }

    /** @return string[] */
    private function normalizeExcludedTerms(string $value): array
    {
        if ($value === '') {
            return [];
        }

        try {
            $decoded = json_decode($value, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }
        if (!is_array($decoded)) {
            return [];
        }

        $terms = [];
        foreach (array_slice($decoded, 0, 5) as $term) {
            $normalized = trim((string)$term);
            if ($normalized !== '' && mb_strlen($normalized) <= 80) {
                $terms[] = $normalized;
            }
        }

        return array_values(array_unique($terms));
    }

    /**
     * Limits a direct-add search to simple products with no required custom
     * option. The option table is authoritative; required_options can be
     * stale when an administrator removes a previously-required option.
     */
    private function applyDirectAddOnlyFilter($collection): void
    {
        $optionTable = $collection->getTable('catalog_product_option');
        $quotedOptionTable = $collection->getConnection()->quoteIdentifier($optionTable);

        $collection->addAttributeToFilter('type_id', ['eq' => 'simple']);
        $collection->getSelect()->where(
            'e.entity_id NOT IN (SELECT required_option.product_id FROM '
            . $quotedOptionTable
            . ' AS required_option WHERE required_option.is_require = 1)'
        );
    }

    /**
     * @return array{0: array<int, array<string, mixed>>, 1: array<int, int>}
     */
    private function collectProductResults($collection, ShopperScope $shopperScope): array
    {
        $resultData = [];
        $productIds = [];

        foreach ($collection as $product) {
            if (!$this->canPresentProduct($product)) {
                continue;
            }

            $product->setCustomerGroupId($shopperScope->getCustomerGroupId());
            $quantityPolicy = $this->saleQuantityPolicy->getPolicy($product);
            $resultData[] = [
                'id' => (int)$product->getId(),
                'product_ref' => 'product:' . (int)$product->getId(),
                'sku' => (string)$product->getSku(),
                'name' => (string)$product->getName(),
                'price' => $this->priceCurrency->format($this->getDisplayFinalPrice($product), false),
                'url' => (string)$product->getProductUrl(),
                'product_type' => (string)$product->getTypeId(),
                'direct_addable' => $this->directAddEligibility->canAddToCartDirectly($product),
                'minimum_qty' => $quantityPolicy['minimum_qty'],
                'maximum_qty' => $quantityPolicy['maximum_qty'],
                'qty_increment' => $quantityPolicy['qty_increment'],
                'default_add_qty' => $quantityPolicy['default_add_qty'],
                'requires_variant_selection' => $product->getTypeId() === 'configurable',
                'in_stock' => true,
                'availability' => 'in_stock',
                'variant_options' => $this->getVariantOptions($product),
                'variant_options_policy' => 'A selectable characteristic is identified by its option label, not by its values. If a requested characteristic has no matching option label, say it is unavailable, then briefly introduce the actual option labels and their purpose. Do not present another option as the requested characteristic; summarize a long value list unless details are requested. Keep shopper-facing prose in the shopper language; the catalogue label itself may remain unchanged.',
            ];
            $productIds[] = (int)$product->getId();
        }

        return [$resultData, $productIds];
    }

    /**
     * Resolve the same product-type-aware price used by Magento's storefront.
     *
     * A configurable parent can legitimately have a zero parent/index value
     * while its eligible children start at a non-zero price. PriceInfo delegates
     * configurable pricing to Magento's child-price resolver, matching the
     * native price renderer used by the product card.
     */
    private function getDisplayFinalPrice($product): float
    {
        $price = $product->getPriceInfo()->getPrice(FinalPrice::PRICE_CODE)->getValue();
        if (is_numeric($price)) {
            return (float)$price;
        }

        $indexedPrice = $product->getData('final_price');

        return is_numeric($indexedPrice)
            ? (float)$indexedPrice
            : (float)$product->getFinalPrice();
    }

    /**
     * Return every configurable dimension from Magento instead of assuming
     * attribute codes such as size, colour, grosse or farbe.
     *
     * @return array<int, array{code: string, label: string, values: array<int, string>}>
     */
    private function getVariantOptions($product): array
    {
        if ($product->getTypeId() !== 'configurable') {
            return [];
        }

        $options = [];
        foreach ($product->getTypeInstance()->getConfigurableAttributesAsArray($product) as $attribute) {
            $values = array_values(array_filter(array_map(
                static fn (array $value): string => trim((string)($value['label'] ?? '')),
                is_array($attribute['values'] ?? null) ? $attribute['values'] : []
            )));
            if ($values === []) {
                continue;
            }

            $code = trim((string)($attribute['attribute_code'] ?? ''));
            $options[] = [
                'code' => $code,
                'label' => trim((string)($attribute['label'] ?? $code)),
                'values' => array_values(array_unique($values)),
            ];
        }

        return $options;
    }

    private function canPresentProduct($product): bool
    {
        return $product
            && in_array($product->getTypeId(), ['simple', 'configurable'], true);
    }

    /**
     * Recover an active product identity when Magento fulltext does not fold a
     * typo, transposition, or missing diacritic. This path runs only for an
     * explicit exact-identity request and retains normal visibility/stock
     * filters, so it cannot become an unbounded catalogue fallback.
     *
     * @param string[] $excludedNameTerms
     * @return array{0: array<int, array<string, mixed>>, 1: int[]}
     */
    private function findActiveIdentityFallback(
        string $query,
        array $excludedNameTerms,
        ShopperScope $shopperScope
    ): array
    {
        $prefix = $this->catalogIdentityMatcher->searchPrefix($query);
        if ($prefix === '') {
            return [[], []];
        }

        $collection = $this->createCategoryProductCollection($shopperScope);
        $collection->addAttributeToFilter('name', ['like' => '%' . $prefix . '%']);
        $this->applyAvailabilityAndPriceFilters($collection, 0.0, 0.0);
        $this->applyExcludedNameTerms($collection, $excludedNameTerms);
        $collection->setPageSize(25);

        $bestDistance = null;
        $bestProducts = [];
        foreach ($collection as $product) {
            $distance = $this->catalogIdentityMatcher->identityDistance(
                $query,
                (string)$product->getName()
            );
            if ($distance === null || ($bestDistance !== null && $distance > $bestDistance)) {
                continue;
            }
            if ($bestDistance === null || $distance < $bestDistance) {
                $bestDistance = $distance;
                $bestProducts = [];
            }
            $bestProducts[] = $product;
        }

        return $this->collectProductResults(
            new \ArrayIterator(array_slice($bestProducts, 0, 5)),
            $shopperScope
        );
    }

    /**
     * Check whether an unavailable product is the likely requested identity.
     *
     * @param string $query Concise product query supplied by the agent.
     */
    private function bestUnavailableProductIdentityDistance(string $query, ShopperScope $shopperScope): ?int
    {
        $prefix = $this->catalogIdentityMatcher->searchPrefix($query);
        if ($prefix === '') {
            return null;
        }

        $collection = $this->productCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToProductCollection(
            $collection,
            $shopperScope,
            true,
            false
        );
        $collection->addAttributeToSelect(['name']);
        $collection->addAttributeToFilter('status', [
            'eq' => (string)\Magento\Catalog\Model\Product\Attribute\Source\Status::STATUS_DISABLED,
        ]);
        $collection->addAttributeToFilter('type_id', ['in' => ['simple', 'configurable']]);
        $collection->addAttributeToFilter('name', ['like' => '%' . $prefix . '%']);
        $collection->setPageSize(25);

        $bestDistance = null;
        foreach ($collection as $product) {
            $distance = $this->catalogIdentityMatcher->identityDistance(
                $query,
                (string)$product->getName()
            );
            if ($distance !== null && ($bestDistance === null || $distance < $bestDistance)) {
                $bestDistance = $distance;
            }
        }

        return $bestDistance;
    }

    /** @param array<int, array<string, mixed>> $products */
    private function bestPresentedProductIdentityDistance(string $query, array $products): ?int
    {
        $bestDistance = null;
        foreach ($products as $product) {
            $distance = $this->catalogIdentityMatcher->identityDistance(
                $query,
                (string)($product['name'] ?? '')
            );
            if ($distance !== null && ($bestDistance === null || $distance < $bestDistance)) {
                $bestDistance = $distance;
            }
        }

        return $bestDistance;
    }

    /**
     * Keep only the closest identity cards for an explicitly named product.
     *
     * @param array<int, array<string, mixed>> $products
     * @param int[] $productIds
     * @return array{0: array<int, array<string, mixed>>, 1: int[]}
     */
    private function filterPresentedIdentityMatches(string $query, array $products, array $productIds): array
    {
        $bestDistance = $this->bestPresentedProductIdentityDistance($query, $products);
        if ($bestDistance === null) {
            return [[], []];
        }

        $filteredProducts = [];
        $filteredIds = [];
        foreach ($products as $index => $product) {
            if ($this->catalogIdentityMatcher->identityDistance(
                $query,
                (string)($product['name'] ?? '')
            ) !== $bestDistance) {
                continue;
            }
            $filteredProducts[] = $product;
            if (isset($productIds[$index])) {
                $filteredIds[] = (int)$productIds[$index];
            }
        }

        return [$filteredProducts, $filteredIds];
    }

    /** @return array<string, mixed> */
    private function getCategoryScope(int $categoryId, ShopperScope $shopperScope): array
    {
        if ($categoryId < 1) {
            return [];
        }

        $collection = $this->categoryCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToCategoryCollection($collection, $shopperScope);
        $collection->addAttributeToSelect(['name', 'url_key']);
        $collection->addIsActiveFilter();
        $collection->addFieldToFilter('entity_id', ['eq' => $categoryId]);
        $collection->setPageSize(1);
        $category = $collection->getFirstItem();

        if (!$category || !(int)$category->getId()) {
            return [];
        }

        return [
            'category_id' => (int)$category->getId(),
            'category_name' => (string)$category->getName(),
            'category_url' => (string)$category->getUrl(),
        ];
    }

    private function applyInternalProductFilters($collection): void
    {
        $collection->addAttributeToFilter('name', ['nlike' => '%Demo Produkt%']);
        $collection->addAttributeToFilter('name', ['nlike' => '%nicht kaufbar%']);
        $collection->addFieldToFilter('sku', ['nlike' => 'demo%']);
        $collection->addFieldToFilter('sku', ['nlike' => 'test%']);
        $collection->addAttributeToFilter('url_key', ['nlike' => 'demo%']);
        $collection->addAttributeToFilter('url_key', ['nlike' => 'test%']);
    }

    /** @param array<int, int> $categoryIds */
    private function expandCategoryIdsWithDescendants(array $categoryIds, ShopperScope $shopperScope): array
    {
        $categoryIds = array_values(array_unique(array_filter(array_map('intval', $categoryIds))));
        if ($categoryIds === []) {
            return [];
        }

        $collection = $this->categoryCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToCategoryCollection($collection, $shopperScope);
        $collection->addAttributeToSelect(['path']);
        $collection->addIsActiveFilter();
        $collection->addFieldToFilter('level', ['gt' => 1]);

        $expanded = [];
        foreach ($collection as $category) {
            $path = (string)$category->getData('path');
            foreach ($categoryIds as $baseId) {
                if ((int)$category->getId() === $baseId
                    || preg_match('#(?:^|/)' . preg_quote((string)$baseId, '#') . '(/|$)#', $path)) {
                    $expanded[] = (int)$category->getId();
                    break;
                }
            }
        }

        return array_values(array_unique(array_filter($expanded)));
    }

    /**
     * Expose the real taxonomy for the agent to inspect and select by ID.
     * No names, translations or category synonyms are embedded in this module.
     */
    public function listCategories(int $customerGroupId = 0, int $customerId = 0)
    {
        $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
        $collection = $this->categoryCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToCategoryCollection($collection, $shopperScope);
        $collection->addAttributeToSelect(['name', 'url_key', 'is_active', 'path']);
        $collection->addIsActiveFilter();
        $collection->addFieldToFilter('level', ['gt' => 1]);
        $collection->setOrder('path', 'ASC');

        // Magento's raw category product_count includes disabled, invisible,
        // out-of-stock, demo and legacy assignments. Recalculate it from the
        // same presentable product filters used by chat search so the model
        // does not select an obsolete duplicate category with hundreds of
        // unusable assignments.
        $activeProducts = $this->createCategoryProductCollection($shopperScope);
        $this->applyAvailabilityAndPriceFilters($activeProducts, 0.0, 0.0);
        $activeProducts->addCountToCategories($collection);

        $categoriesByName = [];
        foreach ($collection as $category) {
            $productCount = (int)$category->getProductCount();
            if ($productCount < 1) {
                continue;
            }
            $categoryData = [
                'id' => (int)$category->getId(),
                'parent_id' => (int)$category->getParentId(),
                'level' => (int)$category->getLevel(),
                'name' => (string)$category->getName(),
                'url' => (string)$category->getUrl(),
                'product_count' => $productCount,
            ];
            $identity = mb_strtolower(trim((string)$category->getName()));
            if (!isset($categoriesByName[$identity])
                || $productCount > $categoriesByName[$identity]['product_count']) {
                $categoriesByName[$identity] = $categoryData;
            }
        }
        $resultData = array_values($categoriesByName);

        $response = $this->toolResponseFactory->create();
        $response->setData($resultData);
        $response->setHtml('');

        return $response;
    }
}
