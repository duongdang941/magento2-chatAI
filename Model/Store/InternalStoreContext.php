<?php
declare(strict_types=1);

namespace Afd\AI\Model\Store;

use Magento\Framework\Exception\LocalizedException;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Executes an authenticated Node-to-Magento request in the store view carried
 * by the Magento-signed WebSocket ticket. It deliberately changes scope only
 * for the lifetime of the current PHP request, then restores the original
 * store so one internal call cannot leak context into another one.
 */
class InternalStoreContext
{
    public function __construct(private readonly StoreManagerInterface $storeManager)
    {
    }

    /**
     * @template T
     * @param callable():T $operation
     * @return T
     */
    public function execute(string $storeCode, callable $operation): mixed
    {
        $storeCode = trim($storeCode);
        if ($storeCode === '') {
            return $operation();
        }

        try {
            $targetStore = $this->storeManager->getStore($storeCode);
        } catch (\Throwable) {
            throw new LocalizedException(__('The requested store is unavailable.'));
        }

        if (!(bool)$targetStore->isActive()) {
            throw new LocalizedException(__('The requested store is unavailable.'));
        }

        $originalStoreId = (int)$this->storeManager->getStore()->getId();
        if ($originalStoreId === (int)$targetStore->getId()) {
            return $operation();
        }

        $this->storeManager->setCurrentStore($targetStore->getId());
        try {
            return $operation();
        } finally {
            $this->storeManager->setCurrentStore($originalStoreId);
        }
    }
}
