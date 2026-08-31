<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Api\CatalogVisibilityPolicyInterface;
use Afd\AI\Model\Catalog\ShopperScope;
use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Data\ToolResponseFactory;
use Magento\Catalog\Model\ResourceModel\Product\CollectionFactory as ProductCollectionFactory;
use Magento\InventorySalesApi\Api\Data\SalesChannelInterface;
use Magento\InventorySalesApi\Api\GetProductSalableQtyInterface;
use Magento\InventorySalesApi\Api\IsProductSalableInterface;
use Magento\InventorySalesApi\Api\StockResolverInterface;
use Magento\Store\Model\StoreManagerInterface;
use Psr\Log\LoggerInterface;

/** Provides authoritative MSI availability without project-specific variant attributes. */
class ProductAvailabilityTool
{
    public function __construct(
        private readonly ProductCollectionFactory $productCollectionFactory,
        private readonly ToolResponseFactory $toolResponseFactory,
        private readonly LoggerInterface $logger,
        private readonly GetProductSalableQtyInterface $getProductSalableQty,
        private readonly IsProductSalableInterface $isProductSalable,
        private readonly StockResolverInterface $stockResolver,
        private readonly StoreManagerInterface $storeManager,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly CatalogVisibilityPolicyInterface $catalogVisibilityPolicy
    ) {
    }

    /**
     * $selectedOptions is JSON because Magento's GET Web API parameter binding
     * is scalar-safe. Its shape is {attribute_code: selected_label} and each
     * code must come from variant_options returned by searchProducts.
     */
    public function getProductAvailability(
        string $sku,
        string $selectedOptions = '',
        int $customerGroupId = 0,
        int $customerId = 0
    )
    {
        $sku = trim($sku);
        $response = $this->toolResponseFactory->create();

        if ($sku === '') {
            $response->setData([['error' => 'A product SKU is required to check availability.']]);
            $response->setHtml('');

            return $response;
        }

        $requestedOptions = $this->decodeSelectedOptions($selectedOptions);

        try {
            $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, $customerId);
            $product = $this->getVisibleProduct($sku, $shopperScope);
            if (!$product) {
                throw new \Magento\Framework\Exception\NoSuchEntityException(__('Product not found.'));
            }
            $stockId = $this->getCurrentStockId($shopperScope);

            $result = $product->getTypeId() === 'configurable'
                ? $this->getConfigurableAvailability($product, $stockId, $requestedOptions, $shopperScope)
                : $this->buildSimpleAvailability($product, $stockId);

            $result['product_ref'] = 'product:' . (int)$product->getId();
            $result['requested_options'] = $requestedOptions;
            $response->setData([$result]);
        } catch (\Magento\Framework\Exception\NoSuchEntityException) {
            $response->setData([[
                'sku' => $sku,
                'availability' => 'not_found',
                'error' => 'Product not found.',
            ]]);
        } catch (\Throwable $exception) {
            $this->logger->error('Unable to get AI product availability.', [
                'sku' => $sku,
                'exception' => $exception,
            ]);
            $response->setData([[
                'sku' => $sku,
                'availability' => 'unknown',
                'error' => 'Availability could not be checked right now.',
            ]]);
        }

        $response->setHtml('');

        return $response;
    }

    private function getCurrentStockId(ShopperScope $shopperScope): int
    {
        $websiteCode = (string)$this->storeManager
            ->getStore($shopperScope->getStoreId())
            ->getWebsite()
            ->getCode();

        return (int)$this->stockResolver
            ->execute(SalesChannelInterface::TYPE_WEBSITE, $websiteCode)
            ->getStockId();
    }

    /**
     * @param array<string, string> $requestedOptions
     * @return array<string, mixed>
     */
    private function getConfigurableAvailability(
        $product,
        int $stockId,
        array $requestedOptions,
        ShopperScope $shopperScope
    ): array
    {
        $configurableAttributes = $product->getTypeInstance()->getConfigurableAttributesAsArray($product);
        $optionDefinitions = $this->getConfigurableOptionDefinitions($configurableAttributes);
        $attributeCodes = array_column($optionDefinitions, 'code');
        $missingOptionCodes = $this->missingConfigurableOptionCodes($attributeCodes, $requestedOptions);

        // A configurable parent has no single inventory pool. A selection of
        // just one dimension (for example size) can still map to several
        // child SKUs whose salable quantities differ. Do not inspect child
        // stock, count matching variants, or expose an in-stock result until
        // Magento receives one complete selection for every configurable
        // attribute.
        if ($missingOptionCodes !== []) {
            return [
                'id' => (int)$product->getId(),
                'sku' => (string)$product->getSku(),
                'name' => (string)$product->getName(),
                'product_type' => 'configurable',
                'requires_variant_selection' => true,
                'availability' => 'selection_required',
                'selection_complete' => false,
                'missing_option_codes' => $missingOptionCodes,
                'variant_options' => $optionDefinitions,
                'variant_options_policy' => 'A configurable parent does not identify one purchasable variant until every returned option code has a selected value. selection_required is neither in-stock nor out-of-stock evidence. Do not state that a partial option selection is available, unavailable, or sufficient for a requested quantity. Keep shopper-facing prose in the shopper language; catalogue labels may remain unchanged.',
            ];
        }
        $children = $product->getTypeInstance()
            ->getUsedProductCollection($product)
            ->addAttributeToSelect(array_values(array_unique(array_merge(['name', 'sku', 'status'], $attributeCodes))));
        // Variants are normally NOT_VISIBLE individually, but their status,
        // store, website and customer-group permissions remain authoritative.
        $this->catalogVisibilityPolicy->applyToProductCollection(
            $children,
            $shopperScope,
            false,
            true
        );

        $variants = [];
        foreach ($children as $child) {
            if (!$child || $child->getTypeId() !== 'simple') {
                continue;
            }
            $variants[] = $this->buildSimpleAvailability($child, $stockId, $attributeCodes);
        }

        $visibleVariants = $requestedOptions === []
            ? $variants
            : array_values(array_filter(
                $variants,
                fn (array $variant): bool => $this->variantMatchesSelection($variant, $requestedOptions)
            ));
        $availableVariants = array_values(array_filter(
            $visibleVariants,
            static fn (array $variant): bool => $variant['availability'] !== 'out_of_stock'
        ));
        // A configurable product does not have one purchasable inventory
        // pool.  Child quantities are useful only after a selection resolves
        // exactly one child SKU.  Do not expose the per-child values for a
        // multi-variant result: an LLM can otherwise add independent sizes,
        // colours, or other options and present the sum as product stock.
        $exposesExactVariantQuantity = count($visibleVariants) === 1;

        $result = [
            'id' => (int)$product->getId(),
            'sku' => (string)$product->getSku(),
            'name' => (string)$product->getName(),
            'product_type' => 'configurable',
            'requires_variant_selection' => true,
            'availability' => $visibleVariants === []
                ? 'not_found'
                : ($availableVariants !== [] ? 'in_stock' : 'out_of_stock'),
            'matching_variants' => count($visibleVariants),
            'available_variants' => count($availableVariants),
            // Preserve the human label and every supported value at the parent
            // level. A child variant only contains code => value, which is not
            // enough context for an agent to distinguish a size from packaging,
            // material, colour, or another store-specific configurable option.
            'variant_options' => $optionDefinitions,
            'variant_options_policy' => 'A selectable characteristic is identified by its option label, not by its values. If a requested characteristic has no matching option label, say it is unavailable, then briefly introduce the actual option labels and their purpose. Do not present another option as the requested characteristic; summarize a long value list unless details are requested. Keep shopper-facing prose in the shopper language; the catalogue label itself may remain unchanged.',
            'variants' => array_slice(
                $this->variantsForResponse($visibleVariants, $exposesExactVariantQuantity),
                0,
                30
            ),
            'has_more_variants' => count($visibleVariants) > 30,
        ];

        if ($exposesExactVariantQuantity) {
            $result['salable_qty'] = $visibleVariants[0]['salable_qty'];
        }

        return $result;
    }

    /**
     * @param array<int, string> $attributeCodes
     * @param array<string, string> $requestedOptions
     * @return array<int, string>
     */
    private function missingConfigurableOptionCodes(array $attributeCodes, array $requestedOptions): array
    {
        $requestedCodes = array_keys($requestedOptions);

        return array_values(array_filter(
            $attributeCodes,
            static fn (string $code): bool => $code !== '' && !in_array($code, $requestedCodes, true)
        ));
    }

    /**
     * Keep variant availability and Magento option facts available for an
     * unresolved configurable selection, but disclose a quantity only when
     * it belongs to the one exactly matched purchasable child SKU.
     *
     * @param array<int, array<string, mixed>> $variants
     * @return array<int, array<string, mixed>>
     */
    private function variantsForResponse(array $variants, bool $exposesExactVariantQuantity): array
    {
        if ($exposesExactVariantQuantity) {
            return $variants;
        }

        return array_map(static function (array $variant): array {
            unset($variant['salable_qty']);

            return $variant;
        }, $variants);
    }

    private function getVisibleProduct(string $sku, ShopperScope $shopperScope)
    {
        $collection = $this->productCollectionFactory->create();
        $this->catalogVisibilityPolicy->applyToProductCollection($collection, $shopperScope);
        $collection->addAttributeToSelect(['name', 'sku', 'type_id']);
        $collection->addAttributeToFilter('sku', ['eq' => $sku]);
        $collection->setPageSize(1);
        $product = $collection->getFirstItem();

        return (int)$product->getId() > 0 ? $product : null;
    }

    /**
     * @param array<int, array<string, mixed>> $configurableAttributes
     * @return array<int, array{code: string, label: string, values: array<int, string>}>
     */
    private function getConfigurableOptionDefinitions(array $configurableAttributes): array
    {
        $definitions = [];

        foreach ($configurableAttributes as $attribute) {
            $code = trim((string)($attribute['attribute_code'] ?? ''));
            if ($code === '') {
                continue;
            }

            $values = array_values(array_unique(array_filter(array_map(
                static fn (array $value): string => trim((string)($value['label'] ?? '')),
                is_array($attribute['values'] ?? null) ? $attribute['values'] : []
            ))));

            $definitions[] = [
                'code' => $code,
                'label' => trim((string)($attribute['label'] ?? $code)),
                'values' => $values,
            ];
        }

        return $definitions;
    }

    /**
     * @param array<int, string> $variantAttributeCodes
     * @return array<string, mixed>
     */
    private function buildSimpleAvailability($product, int $stockId, array $variantAttributeCodes = []): array
    {
        $sku = (string)$product->getSku();
        $salableQty = null;
        $isSalable = false;

        try {
            $isSalable = (bool)$this->isProductSalable->execute($sku, $stockId);
            $salableQty = (float)$this->getProductSalableQty->execute($sku, $stockId);
        } catch (\Throwable $exception) {
            $this->logger->warning('Unable to calculate salable quantity for AI.', [
                'sku' => $sku,
                'exception' => $exception,
            ]);
            $isSalable = (bool)$product->isSaleable();
        }

        $variantOptions = [];
        foreach ($variantAttributeCodes as $attributeCode) {
            $label = $this->getProductAttributeLabel($product, $attributeCode);
            if ($label !== '') {
                $variantOptions[$attributeCode] = $label;
            }
        }

        return [
            'id' => (int)$product->getId(),
            'sku' => $sku,
            'name' => (string)$product->getName(),
            'product_type' => (string)$product->getTypeId(),
            'variant_options' => $variantOptions,
            'availability' => !$isSalable
                ? 'out_of_stock'
                : ($salableQty !== null && $salableQty <= 3 ? 'low_stock' : 'in_stock'),
            'salable_qty' => $salableQty === null ? null : max(0, round($salableQty, 4)),
        ];
    }

    /**
     * @param array<string, mixed> $variant
     * @param array<string, string> $requestedOptions
     */
    private function variantMatchesSelection(array $variant, array $requestedOptions): bool
    {
        $actualOptions = is_array($variant['variant_options'] ?? null) ? $variant['variant_options'] : [];

        foreach ($requestedOptions as $attributeCode => $requestedLabel) {
            if (!isset($actualOptions[$attributeCode])
                || !$this->labelsMatch((string)$actualOptions[$attributeCode], $requestedLabel)) {
                return false;
            }
        }

        return true;
    }

    private function labelsMatch(string $actual, string $requested): bool
    {
        $actual = mb_strtolower(trim($actual));
        $requested = mb_strtolower(trim($requested));

        if ($actual === '' || $requested === '') {
            return false;
        }

        if ($actual === $requested) {
            return true;
        }

        // A short requested label must match exactly: 's' would otherwise
        // also match 'xs' and 'm' would match 'medium'. Longer labels may
        // appear inside a composed value, but only on a word boundary so
        // 'red' still matches 'dark red' without matching 'bordered'.
        if (mb_strlen($requested) < 3) {
            return false;
        }

        $pattern = '~(?<!\w)' . preg_quote($requested, '~') . '(?!\w)~u';

        return preg_match($pattern, $actual) === 1;
    }

    /** @return array<string, string> */
    private function decodeSelectedOptions(string $selectedOptions): array
    {
        if (trim($selectedOptions) === '') {
            return [];
        }

        try {
            $decoded = json_decode($selectedOptions, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }

        if (!is_array($decoded) || array_is_list($decoded)) {
            return [];
        }

        $normalized = [];
        foreach ($decoded as $code => $value) {
            $code = trim((string)$code);
            $value = trim((string)$value);
            if ($code !== '' && $value !== '') {
                $normalized[$code] = $value;
            }
        }

        return $normalized;
    }

    private function getProductAttributeLabel($product, string $attributeCode): string
    {
        $value = $product->getAttributeText($attributeCode);
        if (is_array($value)) {
            return implode(', ', array_filter(array_map('strval', $value)));
        }

        return is_scalar($value) ? (string)$value : '';
    }
}
