<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Afd\AI\Model\Data\ToolResponseFactory;
use Afd\AI\Model\Product\SaleQuantityPolicy;
use Afd\AI\Api\QuoteCartAdapterInterface;
use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Checkout\Model\Cart as CheckoutCart;
use Magento\ConfigurableProduct\Model\Product\Type\Configurable;
use Magento\Framework\Exception\LocalizedException;
use Psr\Log\LoggerInterface;

/** Performs cart mutations for the current Magento checkout session. */
class CartTool
{
    private CheckoutCart $checkoutCart;
    private QuoteCartAdapterInterface $quoteCartAdapter;
    private ProductRepositoryInterface $productRepository;
    private SaleQuantityPolicy $saleQuantityPolicy;
    private ToolResponseFactory $toolResponseFactory;
    private LoggerInterface $logger;

    public function __construct(
        CheckoutCart $checkoutCart,
        QuoteCartAdapterInterface $quoteCartAdapter,
        ProductRepositoryInterface $productRepository,
        SaleQuantityPolicy $saleQuantityPolicy,
        ToolResponseFactory $toolResponseFactory,
        LoggerInterface $logger
    ) {
        $this->checkoutCart = $checkoutCart;
        $this->quoteCartAdapter = $quoteCartAdapter;
        $this->productRepository = $productRepository;
        $this->saleQuantityPolicy = $saleQuantityPolicy;
        $this->toolResponseFactory = $toolResponseFactory;
        $this->logger = $logger;
    }


    /**
     * @inheritDoc
     */
    public function addToCart(string $sku, int $qty = 1)
    {
        $result = $this->addSelectedProductToCart($sku, $qty, [], 'checkout');

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        $response->setHtml('');

        return $response;
    }

    /**
     * Add a product to the cart selected by the shopper in the current HTTP
     * request. Request Quote and Magento checkout have separate sessions, so
     * the target is explicit and defaults to the normal checkout basket.
     *
     * Configurable attributes are resolved from Magento labels rather than
     * trusting a frontend-provided attribute/value ID pair.
     *
     * @param array<string, string> $selectedOptions
     * @return array<string, mixed>
     */
    public function addSelectedProductToCart(
        string $sku,
        int $qty = 1,
        array $selectedOptions = [],
        string $cartTarget = 'checkout',
        bool $useDefaultQuantity = false
    ): array {
        $product = null;
        $isQuoteCart = $cartTarget === 'quote';
        $cart = $isQuoteCart ? $this->quoteCartAdapter->getCart() : $this->checkoutCart;

        if ($cart === null) {
            return $this->quoteCartUnavailable();
        }

        try {
            $product = $this->productRepository->get(trim($sku));
            if (!$product->isSaleable()) {
                return [
                    'status' => 'requires_customer_action',
                    'reason' => 'out_of_stock',
                    'message' => __('This product is not currently available.')->render(),
                    'product' => (string)$product->getName(),
                    'sku' => (string)$product->getSku(),
                    'selected_options' => $selectedOptions,
                ];
            }

            $selection = $this->validateConfigurableSelection($product, $selectedOptions);
            if ($selection['missing'] !== [] || $selection['invalid'] !== []) {
                return [
                    'status' => 'requires_customer_action',
                    'reason' => $selection['missing'] !== []
                        ? 'missing_variant_options'
                        : 'invalid_variant_options',
                    'message' => __('Please select all required product options.')->render(),
                    'product' => (string)$product->getName(),
                    'sku' => (string)$product->getSku(),
                    'selected_options' => $selectedOptions,
                    'missing_options' => $selection['missing'],
                    'invalid_options' => $selection['invalid'],
                    'required_options' => $selection['required'],
                ];
            }

            $quantityPolicy = $this->saleQuantityPolicy->getPolicy($product);
            if ($useDefaultQuantity) {
                $defaultQty = $quantityPolicy['default_add_qty'];
                if ($quantityPolicy['resolved'] !== true || $defaultQty === null) {
                    return $this->invalidQuantityResult($product, $quantityPolicy, $qty);
                }
                $qty = (int)$defaultQty;
            }

            $quantityValidation = $this->saleQuantityPolicy->validate($product, (float)$qty);
            if ($quantityValidation['valid'] !== true) {
                return $this->invalidQuantityResult($product, $quantityValidation, $qty);
            }

            // selectedOptions is the configurable-product contract. A model
            // can occasionally carry a stale selection from a previous card
            // into a simple-product add request; Magento has no super
            // attributes to apply in that case. Ignore that stale metadata so
            // a Magento-validated direct-addable simple product is not
            // incorrectly reported as requiring a product-page configuration.
            // Required custom options, if any, are still validated by
            // Magento's addProduct call below and remain product-page-only.
            if ($product->getTypeId() !== Configurable::TYPE_CODE) {
                $selectedOptions = [];
            }

            $existingQty = $this->getExistingProductQty($cart, (int)$product->getId());
            if ($existingQty > 0.0) {
                $combinedValidation = $this->saleQuantityPolicy->validate(
                    $product,
                    $existingQty + $qty
                );
                if ($combinedValidation['valid'] !== true) {
                    return $this->invalidQuantityResult(
                        $product,
                        $combinedValidation,
                        $qty,
                        $existingQty + $qty
                    );
                }
            }

            $params = $this->buildAddToCartParams($product, $qty, $selectedOptions);
            $cart->addProduct($product, $params);
            $cart->save();

            if (!$this->quoteContainsProduct($cart, (int)$product->getId())) {
                throw new \RuntimeException('The selected cart did not retain the requested product.');
            }

            return [
                'status' => 'success',
                'message' => __('%1 has been added to your cart.', $product->getName())->render(),
                'product' => $product->getName(),
                'sku' => (string)$product->getSku(),
                'qty' => $params['qty'],
                'selected_options' => $selectedOptions,
                'cart_qty' => (float)$cart->getQuote()->getItemsQty(),
                'cart_type' => $isQuoteCart ? 'request_quote' : 'checkout',
                // Returned to the trusted browser controller for analytics
                // correlation, then removed before the response reaches Node.
                'quote_id' => (int)$cart->getQuote()->getId(),
            ];
        } catch (LocalizedException $exception) {
            // Magento also uses LocalizedException for inventory failures. Do
            // not report those as a product-page configuration requirement:
            // the shopper may have selected a valid product but requested more
            // units than are currently salable.
            if ($this->isInsufficientStockException($exception)) {
                $this->logger->warning('Afd AI cart action exceeds current salable stock.', [
                    'sku' => $product ? (string)$product->getSku() : trim($sku),
                    'requested_qty' => $qty,
                    'message' => $exception->getMessage(),
                ]);

                return [
                    'status' => 'requires_customer_action',
                    'reason' => 'insufficient_stock',
                    'message' => __('The requested quantity is not currently available.')->render(),
                    'product' => $product ? (string)$product->getName() : '',
                    'sku' => $product ? (string)$product->getSku() : trim($sku),
                    'requested_qty' => $qty,
                ];
            }

            // Extensions may require a design, upload, engraving, or another
            // product-page step that the chat cannot safely fabricate. Treat
            // other shopper-correctable Magento cart exceptions as a
            // structured outcome so the model never falls back to a fresh
            // product search.
            $this->logger->warning('Afd AI cart action needs shopper input.', [
                'sku' => $product ? (string)$product->getSku() : trim($sku),
                'message' => $exception->getMessage(),
            ]);
            return [
                'status' => 'requires_customer_action',
                'reason' => 'product_page_required',
                'message' => __('This item needs an additional configuration on its product page before it can be added to the cart.')->render(),
                'product' => $product ? (string)$product->getName() : '',
                'sku' => $product ? (string)$product->getSku() : trim($sku),
                'url' => $product ? (string)$product->getProductUrl() : '',
            ];
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI could not add an item to the cart.', [
                'sku' => trim($sku),
                'exception' => $exception,
            ]);

            return [
                'status' => 'error',
                'message' => __('The selected product could not be added to the cart.')->render(),
            ];
        }
    }

    private function isInsufficientStockException(LocalizedException $exception): bool
    {
        $message = mb_strtolower(trim($exception->getMessage()));
        if ($message === '') {
            return false;
        }

        return str_contains($message, 'requested qty')
            || str_contains($message, 'requested quantity')
            || str_contains($message, 'quantity is not available')
            || str_contains($message, 'requested amount is not available')
            || (str_contains($message, 'gewünschte menge') && str_contains($message, 'nicht verfügbar'))
            || (str_contains($message, 'angeforderte menge') && str_contains($message, 'nicht verfügbar'));
    }

    private function quoteContainsProduct(object $cart, int $productId): bool
    {
        foreach ($cart->getQuote()->getAllVisibleItems() as $item) {
            if ((int)$item->getProductId() === $productId
                || (int)($item->getParentItem()?->getProductId() ?? 0) === $productId) {
                return true;
            }
        }

        return false;
    }

    private function getExistingProductQty(object $cart, int $productId): float
    {
        $qty = 0.0;
        foreach ($cart->getQuote()->getAllVisibleItems() as $item) {
            if ((int)$item->getProductId() === $productId
                || (int)($item->getParentItem()?->getProductId() ?? 0) === $productId) {
                $qty += (float)$item->getQty();
            }
        }

        return $qty;
    }

    /**
     * @param array<string, mixed> $policy
     * @return array<string, mixed>
     */
    private function invalidQuantityResult(
        $product,
        array $policy,
        int $requestedQty,
        ?float $cartLineQty = null
    ): array {
        return [
            'status' => 'requires_customer_action',
            'reason' => 'invalid_quantity',
            'message' => __('Please choose a quantity allowed for this product.')->render(),
            'product' => (string)$product->getName(),
            'sku' => (string)$product->getSku(),
            'requested_qty' => $requestedQty,
            'minimum_qty' => $policy['minimum_qty'] ?? 1,
            'maximum_qty' => $policy['maximum_qty'] ?? null,
            'qty_increment' => $policy['qty_increment'] ?? 1,
            'default_add_qty' => $policy['default_add_qty'] ?? null,
            'cart_line_qty' => $cartLineQty,
        ];
    }

    /**
     * Validate the model-provided labels before a quote mutation. This lets
     * the gateway distinguish an incomplete configurable selection from a
     * genuinely unavailable variant.
     *
     * @param array<string, string> $selectedOptions
     * @return array{missing: array<int, array<string, string>>, invalid: array<int, array<string, string>>, required: array<int, array<string, mixed>>}
     */
    private function validateConfigurableSelection($product, array $selectedOptions): array
    {
        if ($product->getTypeId() !== Configurable::TYPE_CODE) {
            return ['missing' => [], 'invalid' => [], 'required' => []];
        }

        $missing = [];
        $invalid = [];
        $required = [];
        $knownCodes = [];

        foreach ($product->getTypeInstance()->getConfigurableAttributesAsArray($product) as $attribute) {
            $code = trim((string)($attribute['attribute_code'] ?? ''));
            $label = trim((string)($attribute['label'] ?? $code));
            $values = is_array($attribute['values'] ?? null) ? $attribute['values'] : [];
            if ($code === '') {
                continue;
            }

            $knownCodes[$code] = true;
            $required[] = [
                'code' => $code,
                'label' => $label,
                'values' => array_values(array_filter(array_map(
                    static fn (array $value): string => trim((string)($value['label'] ?? '')),
                    $values
                ))),
            ];

            $selectedLabel = trim((string)($selectedOptions[$code] ?? ''));
            if ($selectedLabel === '') {
                $missing[] = ['code' => $code, 'label' => $label];
                continue;
            }
            if ($this->findOptionValueIndex($values, $selectedLabel) === null) {
                $invalid[] = ['code' => $code, 'label' => $label, 'value' => $selectedLabel];
            }
        }

        foreach ($selectedOptions as $code => $value) {
            if (!isset($knownCodes[$code])) {
                $invalid[] = [
                    'code' => (string)$code,
                    'label' => (string)$code,
                    'value' => (string)$value,
                ];
            }
        }

        return ['missing' => $missing, 'invalid' => $invalid, 'required' => $required];
    }

    /**
     * @param array<string, string> $selectedOptions
     * @return array<string, mixed>
     */
    private function buildAddToCartParams($product, int $qty, array $selectedOptions): array
    {
        $params = [
            'product' => (int)$product->getId(),
            'qty' => max(1, min($qty, 1000000)),
        ];

        if ($product->getTypeId() !== Configurable::TYPE_CODE) {
            if ($selectedOptions !== []) {
                throw new LocalizedException(__('This product does not support the selected options.'));
            }

            return $params;
        }

        $superAttributes = [];
        $knownCodes = [];
        foreach ($product->getTypeInstance()->getConfigurableAttributesAsArray($product) as $attribute) {
            $code = trim((string)($attribute['attribute_code'] ?? ''));
            $attributeId = (int)($attribute['attribute_id'] ?? 0);
            $selectedLabel = trim((string)($selectedOptions[$code] ?? ''));
            if ($code === '' || $attributeId <= 0 || $selectedLabel === '') {
                throw new LocalizedException(__('Please select all required product options.'));
            }

            $valueIndex = $this->findOptionValueIndex(
                is_array($attribute['values'] ?? null) ? $attribute['values'] : [],
                $selectedLabel
            );
            if ($valueIndex === null) {
                throw new LocalizedException(__('The selected product option is no longer available.'));
            }

            $knownCodes[$code] = true;
            $superAttributes[$attributeId] = $valueIndex;
        }

        foreach (array_keys($selectedOptions) as $code) {
            if (!isset($knownCodes[$code])) {
                throw new LocalizedException(__('The selected product option is invalid.'));
            }
        }

        $params['super_attribute'] = $superAttributes;

        return $params;
    }

    /** @param array<int, array<string, mixed>> $values */
    private function findOptionValueIndex(array $values, string $selectedLabel): ?int
    {
        $needle = $this->normalizeOptionLabel($selectedLabel);
        if ($needle === '') {
            return null;
        }

        foreach ($values as $value) {
            $label = $this->normalizeOptionLabel((string)($value['label'] ?? ''));
            $valueIndex = (int)($value['value_index'] ?? 0);
            if ($label !== '' && $valueIndex > 0 && $label === $needle) {
                return $valueIndex;
            }
        }

        return null;
    }

    private function normalizeOptionLabel(string $value): string
    {
        return mb_strtolower(trim(preg_replace('/\s+/u', ' ', $value) ?? ''));
    }

    /**
     * @inheritDoc
     */
    public function updateCartItem(string $sku, int $qty)
    {
        try {
            $quote = $this->checkoutCart->getQuote();
            $itemFound = false;
            $productName = '';

            foreach ($quote->getAllVisibleItems() as $item) {
                if ($item->getSku() === $sku) {
                    $item->setQty($qty);
                    $productName = $item->getName();
                    $itemFound = true;
                    break;
                }
            }

            if ($itemFound) {
                $this->checkoutCart->save();
                $result = [
                    'status' => 'OK',
                    'message' => __('%1 quantity has been updated to %2.', $productName, $qty)->render(),
                    'sku' => $sku,
                    'qty' => $qty
                ];
            } else {
                $result = [
                    'status' => 'NOT_FOUND',
                    'message' => __('Product with SKU %1 was not found in your cart.', $sku)->render()
                ];
            }
        } catch (\Exception $e) {
            $result = [
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ];
        }

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        $response->setHtml('');
        return $response;
    }

    /**
     * @inheritDoc
     */
    public function removeFromCart(string $sku, string $cartTarget = 'checkout')
    {
        $result = $this->removeSelectedProductFromCart($sku, $cartTarget);

        /** @var \Afd\AI\Api\Data\ToolResponseInterface $response */
        $response = $this->toolResponseFactory->create();
        $response->setData([$result]);
        $response->setHtml('');
        return $response;
    }

    /**
     * Remove every visible line for a catalogue SKU from the selected cart
     * belonging to the active browser session.
     *
     * @return array<string, mixed>
     */
    public function removeSelectedProductFromCart(
        string $sku,
        string $cartTarget = 'checkout'
    ): array {
        $sku = trim($sku);
        $isQuoteCart = $cartTarget === 'quote';
        $cart = $isQuoteCart ? $this->quoteCartAdapter->getCart() : $this->checkoutCart;
        $cartType = $isQuoteCart ? 'request_quote' : 'checkout';

        if ($cart === null) {
            return $this->quoteCartUnavailable();
        }

        try {
            $quote = $cart->getQuote();
            $removedItemIds = [];
            $productName = '';

            foreach ($quote->getAllVisibleItems() as $item) {
                if ($this->cartItemMatchesSku($item, $sku)) {
                    $productName = $productName ?: (string)$item->getName();
                    $removedItemIds[] = (int)$item->getItemId();
                }
            }

            if ($removedItemIds === []) {
                return [
                    'status' => 'requires_customer_action',
                    'reason' => 'product_not_found_in_cart',
                    'message' => $isQuoteCart
                        ? __('This product was not found in your Quote Cart.')->render()
                        : __('This product was not found in your cart.')->render(),
                    'sku' => $sku,
                    'cart_type' => $cartType,
                    'cart_qty' => (float)$quote->getItemsQty(),
                ];
            }

            foreach ($removedItemIds as $itemId) {
                $cart->removeItem($itemId);
            }
            $cart->save();

            if ($this->quoteContainsSku($cart, $sku)) {
                throw new \RuntimeException('The selected cart retained the requested product after removal.');
            }

            return [
                'status' => 'success',
                'message' => $isQuoteCart
                    ? __('%1 has been removed from your Quote Cart.', $productName)->render()
                    : __('%1 has been removed from your cart.', $productName)->render(),
                'product' => $productName,
                'sku' => $sku,
                'removed_lines' => count($removedItemIds),
                'cart_qty' => (float)$cart->getQuote()->getItemsQty(),
                'cart_type' => $cartType,
            ];
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI could not remove an item from the cart.', [
                'sku' => $sku,
                'cart_type' => $cartType,
                'exception' => $exception,
            ]);

            return [
                'status' => 'error',
                'message' => $isQuoteCart
                    ? __('The selected product could not be removed from your Quote Cart.')->render()
                    : __('The selected product could not be removed from your cart.')->render(),
                'sku' => $sku,
                'cart_type' => $cartType,
            ];
        }
    }

    private function quoteContainsSku(object $cart, string $sku): bool
    {
        foreach ($cart->getQuote()->getAllVisibleItems() as $item) {
            if ($this->cartItemMatchesSku($item, $sku)) {
                return true;
            }
        }

        return false;
    }

    private function cartItemMatchesSku($item, string $sku): bool
    {
        $candidateSkus = [
            (string)$item->getSku(),
            (string)($item->getProduct()?->getSku() ?? ''),
        ];

        foreach ($item->getChildren() ?: [] as $childItem) {
            $candidateSkus[] = (string)$childItem->getSku();
            $candidateSkus[] = (string)($childItem->getProduct()?->getSku() ?? '');
        }

        foreach ($candidateSkus as $candidateSku) {
            if ($candidateSku !== '' && strcasecmp($candidateSku, $sku) === 0) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, mixed> */
    private function quoteCartUnavailable(): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => 'quote_cart_unavailable',
            'message' => __('Quote Cart is not available on this store.')->render(),
            'cart_type' => 'request_quote',
        ];
    }
}
