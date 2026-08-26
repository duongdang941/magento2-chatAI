<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Catalog\PriceConstraintConverter;
use Afd\AI\Model\Config\Config;
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
        private readonly PriceConstraintConverter $priceConstraintConverter,
        private readonly Config $config
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
        string $requiredVariantAttributeCode = '',
        string $requiredVariantOptionValues = '',
        string $excludedVariantOptionValues = '',
        int $customerGroupId = 0,
        int $customerId = 0
    ) {
        $query = trim($query);
        $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
        $excludedNameTerms = $this->normalizeExcludedTerms($excludedTerms);
        $requiredVariantAttributeCode = $this->normalizeVariantAttributeCode($requiredVariantAttributeCode);
        $requiredVariantOptionValues = $this->normalizeVariantOptionValues($requiredVariantOptionValues);
        $excludedVariantOptionValues = $this->normalizeVariantOptionValues($excludedVariantOptionValues);
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

        // Follow Magento's native full-text collection lifecycle: set the
        // requested page before getSize() triggers the search adapter. The
        // Elasticsearch adapter then retrieves only this page of IDs while
        // preserving the backend total. The former implementation resolved
        // every matching ID, ran an additional SQL COUNT and called clear(),
        // which made the collection perform the full-text search a second
        // time before one five-card page could be rendered.
        $collection = $this->createFilteredProductCollection(
            $query,
            $categoryIds,
            $minPrice,
            $maxPrice,
            $directAddOnly,
            $excludedNameTerms,
            $requiredVariantAttributeCode,
            $requiredVariantOptionValues,
            $excludedVariantOptionValues,
            $shopperScope
        );
        $collection->setCurPage($page);
        $collection->setPageSize($limit);
        $totalResults = $this->getCollectionSize($collection);
        if ($query !== '' && $page === 1 && $totalResults > 0 && $totalResults <= $limit) {
            // Full-text totals originate in Elasticsearch while the explicit
            // visibility/stock policy is also applied in SQL. When the whole
            // result set fits in this one page, count just those already
            // selected IDs so customer prose and rendered cards cannot diverge
            // (for example 4 indexed hits but 3 visible products). This never
            // asks Elasticsearch for more IDs or restarts the search.
            $totalResults = $this->getLoadedPageFilteredSize($collection);
        }

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
        // The bounded identity fallback is safe for genuine relevance-empty
        // page-1 searches without SQL-level catalogue constraints: its matcher
        // rejects short broad facets and requires all meaningful query tokens
        // to map to one product name. It rebuilds retrieval without category,
        // price or direct-add filters and ignores the page boundary, so it
        // must never replace an honest empty result for a constrained or
        // paginated request; otherwise cards could violate the very
        // constraints that meta still claims were applied.
        $identityFallbackAllowed = $this->shouldAttemptIdentityFallback($query, $exactIdentity)
            && $categoryIds === []
            && $minPrice <= 0.0
            && $maxPrice <= 0.0
            && !$directAddOnly
            && $requiredVariantAttributeCode === ''
            && $page === 1;
        if ($resultData === []
            && $activeIdentityDistance === null
            && $query !== ''
            && $identityFallbackAllowed
        ) {
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
        $disabledIdentityDistance = $identityFallbackAllowed
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
                'required_variant_attribute_code' => $requiredVariantAttributeCode,
                'required_variant_option_values' => $requiredVariantOptionValues,
                'excluded_variant_option_values' => $excludedVariantOptionValues,
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
        string $requiredVariantAttributeCode,
        array $requiredVariantOptionValues,
        array $excludedVariantOptionValues,
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
        if ($requiredVariantAttributeCode !== '') {
            $this->applyVariantAttributeRequirementFilter(
                $collection,
                $requiredVariantAttributeCode,
                $requiredVariantOptionValues,
                $excludedVariantOptionValues,
                $shopperScope
            );
        }

        return $collection;
    }

    /**
     * Resolve the total through the collection's native engine.
     *
     * For Magento full-text collections, getSize() returns the search
     * adapter's total count and keeps the page boundary that was set before
     * loading. For a regular category collection it issues Magento's normal
     * count query. Do not rebuild a count select manually: after the search
     * adapter has applied its page of IDs, that would either count an
     * incomplete page or require loading every matching ID again.
     */
    private function getCollectionSize($collection): int
    {
        return (int)$collection->getSize();
    }

    /**
     * Count only the ID selection that the loaded full-text page already owns.
     *
     * This is intentionally used only when the engine total fits into the
     * first page; using it for a broad query would reintroduce the expensive
     * full-result count that this tool avoids.
     */
    private function getLoadedPageFilteredSize($collection): int
    {
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

    private function normalizeVariantAttributeCode(string $value): string
    {
        $code = strtolower(trim($value));

        return preg_match('/^[a-z][a-z0-9_]{0,63}$/', $code) ? $code : '';
    }

    /** @return string[] */
    private function normalizeVariantOptionValues(string $value): array
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

        $values = [];
        foreach (array_slice($decoded, 0, 12) as $item) {
            $normalized = trim((string)$item);
            if ($normalized !== '' && mb_strlen($normalized) <= 120) {
                $values[] = $normalized;
            }
        }

        return array_values(array_unique($values));
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

    /**
     * Require one actual configurable dimension returned by
     * listVariantAttributes(). The gateway supplies a Magento attribute code,
     * never a translated semantic such as "colour", so this stays reusable
     * across stores and prevents a no-match fallback from showing unrelated
     * products that merely share a category.
     *
     * @param string[] $requiredOptionValues
     * @param string[] $excludedOptionValues
     */
    private function applyVariantAttributeRequirementFilter(
        $collection,
        string $attributeCode,
        array $requiredOptionValues,
        array $excludedOptionValues,
        ShopperScope $shopperScope
    ): void {
        $connection = $collection->getConnection();
        $superLinkTable = $connection->quoteIdentifier($collection->getTable('catalog_product_super_link'));
        $superAttributeTable = $connection->quoteIdentifier($collection->getTable('catalog_product_super_attribute'));
        $attributeTable = $connection->quoteIdentifier($collection->getTable('eav_attribute'));
        $entityIntTable = $connection->quoteIdentifier($collection->getTable('catalog_product_entity_int'));
        $entityVarcharTable = $connection->quoteIdentifier($collection->getTable('catalog_product_entity_varchar'));
        $optionValueTable = $connection->quoteIdentifier($collection->getTable('eav_attribute_option_value'));
        $storeId = max(0, $shopperScope->getStoreId());
        $availableValue = 'LOWER(COALESCE(NULLIF(option_store.value, \'\'), option_default.value))';
        $excludedSql = '';
        if ($excludedOptionValues !== []) {
            $quotedValues = array_map(
                static fn (string $value): string => $connection->quote(mb_strtolower($value)),
                $excludedOptionValues
            );
            $excludedSql = ' AND ' . $availableValue . ' NOT IN (' . implode(', ', $quotedValues) . ')';
        }

        $requiredSql = '';
        if ($requiredOptionValues !== []) {
            $quotedValues = array_map(
                static fn (string $value): string => $connection->quote(mb_strtolower($value)),
                $requiredOptionValues
            );
            $requiredSql = ' AND ' . $availableValue . ' IN (' . implode(', ', $quotedValues) . ')';
        }

        $variantMatch = 'EXISTS (SELECT 1'
            . ' FROM ' . $superLinkTable . ' AS variant_link'
            . ' INNER JOIN ' . $superAttributeTable . ' AS configurable_attribute'
            . ' ON configurable_attribute.product_id = variant_link.parent_id'
            . ' INNER JOIN ' . $attributeTable . ' AS configurable_attribute_definition'
            . ' ON configurable_attribute_definition.attribute_id = configurable_attribute.attribute_id'
            . ' INNER JOIN ' . $entityIntTable . ' AS variant_attribute'
            . ' ON variant_attribute.entity_id = variant_link.product_id'
            . ' AND variant_attribute.attribute_id = configurable_attribute.attribute_id'
            . ' AND variant_attribute.store_id = 0'
            . ' INNER JOIN ' . $optionValueTable . ' AS option_default'
            . ' ON option_default.option_id = variant_attribute.value'
            . ' AND option_default.store_id = 0'
            . ' LEFT JOIN ' . $optionValueTable . ' AS option_store'
            . ' ON option_store.option_id = option_default.option_id'
            . ' AND option_store.store_id = ' . (int)$storeId
            . ' WHERE variant_link.parent_id = e.entity_id'
            . ' AND configurable_attribute_definition.attribute_code = ?'
            . $requiredSql
            . $excludedSql
            . ')';

        if ($requiredOptionValues === []) {
            $collection->addAttributeToFilter('type_id', ['eq' => 'configurable']);
            $collection->getSelect()->where($variantMatch, $attributeCode);
            return;
        }

        // A catalogue can encode a fixed characteristic in the product name
        // instead of a configurable child. Keep it only when the exact value
        // has already been verified for this attribute in Magento; a broad
        // fulltext match alone must never establish the characteristic.
        $nameValue = 'LOWER(COALESCE(NULLIF(name_store.value, \'\'), name_default.value))';
        $nameMatches = array_map(
            static fn (string $value): string => $nameValue . ' LIKE ' . $connection->quote('%' . mb_strtolower($value) . '%'),
            $requiredOptionValues
        );
        $nameMatch = 'EXISTS (SELECT 1'
            . ' FROM ' . $entityVarcharTable . ' AS name_default'
            . ' INNER JOIN ' . $attributeTable . ' AS name_attribute'
            . ' ON name_attribute.attribute_id = name_default.attribute_id'
            . ' AND name_attribute.attribute_code = \'name\''
            . ' LEFT JOIN ' . $entityVarcharTable . ' AS name_store'
            . ' ON name_store.entity_id = name_default.entity_id'
            . ' AND name_store.attribute_id = name_default.attribute_id'
            . ' AND name_store.store_id = ' . (int)$storeId
            . ' WHERE name_default.entity_id = e.entity_id'
            . ' AND name_default.store_id = 0'
            . ' AND (' . implode(' OR ', $nameMatches) . ')'
            . ')';

        $collection->getSelect()->where('(' . $variantMatch . ' OR ' . $nameMatch . ')', $attributeCode);
    }

    private function canPresentProduct($product): bool
    {
        return $product
            && in_array($product->getTypeId(), ['simple', 'configurable'], true);
    }

    /**
     * A full-text miss for a generic product family is not evidence of a
     * misspelled product identity. Running LIKE '%abc%' fallbacks for every
     * short one-word query turns normal discovery (for example, "Jacke") into
     * a catalogue scan. Keep typo recovery for an explicit identity request,
     * multiple meaningful identity terms, or one distinctive long term. This
     * is deliberately language-neutral and depends only on token structure.
     */
    private function shouldAttemptIdentityFallback(string $query, bool $exactIdentity): bool
    {
        if ($exactIdentity) {
            return true;
        }

        $tokens = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower(trim($query))) ?: [];
        $tokens = array_values(array_filter(
            $tokens,
            static fn (string $token): bool => mb_strlen($token) >= 3
        ));
        if (count($tokens) >= 2) {
            return true;
        }

        return isset($tokens[0]) && mb_strlen($tokens[0]) >= 8;
    }

    /**
     * Recover an active product identity when Magento fulltext does not fold a
     * typo, transposition, or missing diacritic. searchProducts() calls this
     * only for a relevance-empty, unconstrained, first-page query and retains
     * normal visibility/stock filters, so it cannot become an unbounded
     * catalogue fallback.
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
        foreach ($this->config->getCatalogExcludedNameTerms() as $term) {
            $collection->addAttributeToFilter('name', ['nlike' => '%' . $term . '%']);
        }

        foreach ($this->config->getCatalogExcludedKeyPrefixes() as $prefix) {
            $collection->addFieldToFilter('sku', ['nlike' => $prefix . '%']);
            $collection->addAttributeToFilter('url_key', ['nlike' => $prefix . '%']);
        }
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

    /**
     * Describe configurable dimensions from a verified category without
     * presenting a product grid. This is the safe discovery step for a
     * failed attribute request: the model can request alternatives through
     * the exact code Magento supplies instead of guessing an attribute name.
     */
    public function listVariantAttributes(int $categoryId, int $customerGroupId = 0, int $customerId = 0)
    {
        $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
        $categoryScope = $this->getCategoryScope($categoryId, $shopperScope);
        $categoryIds = $categoryScope === []
            ? []
            : $this->expandCategoryIdsWithDescendants([$categoryId], $shopperScope);
        $response = $this->toolResponseFactory->create();
        if ($categoryIds === []) {
            $response->setData([]);
            $response->setHtml('');
            $response->setMeta(['scope' => [...$shopperScope->toArray(), ...$categoryScope]]);
            return $response;
        }

        $collection = $this->createCategoryProductCollection($shopperScope);
        $collection->addAttributeToFilter('type_id', ['eq' => 'configurable']);
        $collection->addCategoriesFilter(['in' => $categoryIds]);
        $this->applyAvailabilityAndPriceFilters($collection, 0.0, 0.0);

        // Attribute discovery is evidence, not a product dump. Bound the
        // work while retaining a truthful flag for unusually large categories.
        $sampleLimit = 200;
        $collection->setCurPage(1);
        $collection->setPageSize($sampleLimit);
        $totalProducts = $this->getCollectionSize($collection);

        $attributes = [];
        foreach ($collection as $product) {
            foreach ($this->getVariantOptions($product) as $option) {
                $code = $this->normalizeVariantAttributeCode((string)($option['code'] ?? ''));
                $label = trim((string)($option['label'] ?? ''));
                if ($code === '' || $label === '') {
                    continue;
                }
                if (!isset($attributes[$code])) {
                    $attributes[$code] = [
                        'code' => $code,
                        'label' => $label,
                        'values' => [],
                        'sampled_product_count' => 0,
                    ];
                }
                $attributes[$code]['sampled_product_count']++;
                foreach (is_array($option['values'] ?? null) ? $option['values'] : [] as $value) {
                    $value = trim((string)$value);
                    if ($value === '') {
                        continue;
                    }
                    $attributes[$code]['values'][mb_strtolower($value)] = $value;
                }
            }
        }

        ksort($attributes, SORT_NATURAL | SORT_FLAG_CASE);
        $resultData = array_map(static function (array $attribute): array {
            $values = array_values($attribute['values']);
            sort($values, SORT_NATURAL | SORT_FLAG_CASE);
            return [
                'code' => $attribute['code'],
                'label' => $attribute['label'],
                'values' => array_slice($values, 0, 80),
                'sampled_product_count' => (int)$attribute['sampled_product_count'],
            ];
        }, array_values($attributes));

        $response->setData($resultData);
        $response->setHtml('');
        $response->setMeta([
            'scope' => [...$shopperScope->toArray(), ...$categoryScope],
            'sampled_configurable_products' => min($totalProducts, $sampleLimit),
            'has_more_configurable_products' => $totalProducts > $sampleLimit,
        ]);

        return $response;
    }
}
