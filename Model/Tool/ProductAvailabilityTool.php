<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Model\Data\ToolResponseFactory;
use Magento\Catalog\Api\ProductRepositoryInterface;
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
        private readonly ProductRepositoryInterface $productRepository,
        private readonly ToolResponseFactory $toolResponseFactory,
        private readonly LoggerInterface $logger,
        private readonly GetProductSalableQtyInterface $getProductSalableQty,
        private readonly IsProductSalableInterface $isProductSalable,
        private readonly StockResolverInterface $stockResolver,
        private readonly StoreManagerInterface $storeManager
    ) {
    }

    /**
     * $selectedOptions is JSON because Magento's GET Web API parameter binding
     * is scalar-safe. Its shape is {attribute_code: selected_label} and each
     * code must come from variant_options returned by searchProducts.
     */
    public function getProductAvailability(string $sku, string $selectedOptions = '')
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
            $product = $this->productRepository->get($sku);
            $stockId = $this->getCurrentStockId();

            $result = $product->getTypeId() === 'configurable'
                ? $this->getConfigurableAvailability($product, $stockId, $requestedOptions)
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

    private function getCurrentStockId(): int
    {
        $websiteCode = (string)$this->storeManager->getStore()->getWebsite()->getCode();

        return (int)$this->stockResolver
            ->execute(SalesChannelInterface::TYPE_WEBSITE, $websiteCode)
            ->getStockId();
    }

    /**
     * @param array<string, string> $requestedOptions
     * @return array<string, mixed>
     */
    private function getConfigurableAvailability($product, int $stockId, array $requestedOptions): array
    {
        $configurableAttributes = $product->getTypeInstance()->getConfigurableAttributesAsArray($product);
        $optionDefinitions = $this->getConfigurableOptionDefinitions($configurableAttributes);
        $attributeCodes = array_column($optionDefinitions, 'code');
        $children = $product->getTypeInstance()
            ->getUsedProductCollection($product)
            ->addAttributeToSelect(array_values(array_unique(array_merge(['name', 'sku', 'status'], $attributeCodes))));

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
            'variants' => array_slice($visibleVariants, 0, 30),
            'has_more_variants' => count($visibleVariants) > 30,
        ];

        if (count($visibleVariants) === 1) {
            $result['salable_qty'] = $visibleVariants[0]['salable_qty'];
        }

        return $result;
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

        return $actual !== '' && $requested !== '' && ($actual === $requested || str_contains($actual, $requested));
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
