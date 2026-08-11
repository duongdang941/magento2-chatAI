<?php
declare(strict_types=1);

namespace Afd\AI\Model\Cart;

use Afd\AI\Api\QuoteCartAdapterInterface;
use Magento\Framework\ObjectManagerInterface;

/**
 * Isolates the optional Amasty dependency from the module core.
 *
 * Magento does not support conditional constructor arguments for absent
 * modules. Resolving the extension behind this adapter keeps DI compilation
 * portable while still reusing the installed extension's session cart.
 */
class OptionalQuoteCartAdapter implements QuoteCartAdapterInterface
{
    private ?object $cart = null;
    private bool $resolved = false;

    public function __construct(
        private readonly ObjectManagerInterface $objectManager,
        private readonly string $cartClass = 'Amasty\RequestQuote\Model\Cart'
    ) {
    }

    public function isAvailable(): bool
    {
        return $this->getCart() !== null;
    }

    public function getCart(): ?object
    {
        if ($this->resolved) {
            return $this->cart;
        }
        $this->resolved = true;
        if (!class_exists($this->cartClass)) {
            return null;
        }

        try {
            $candidate = $this->objectManager->get($this->cartClass);
            if (is_object($candidate)
                && method_exists($candidate, 'addProduct')
                && method_exists($candidate, 'getQuote')
                && method_exists($candidate, 'save')
                && method_exists($candidate, 'removeItem')
            ) {
                $this->cart = $candidate;
            }
        } catch (\Throwable) {
            $this->cart = null;
        }

        return $this->cart;
    }
}
