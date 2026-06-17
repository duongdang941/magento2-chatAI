<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Backend;

use Magento\Framework\App\ObjectManager;
use Magento\Framework\Encryption\EncryptorInterface;

/**
 * Renders values encrypted by the legacy field definition as ordinary text.
 * New saves use Magento's default value backend and are intentionally stored
 * as plain text, matching the local-development configuration policy.
 */
class VisibleValue extends \Magento\Framework\App\Config\Value
{
    protected function _afterLoad()
    {
        $value = (string)$this->getValue();
        if ($value === '' || !preg_match('/^\d+:\d+:[A-Za-z0-9+\/=]+$/', $value)) {
            return;
        }

        try {
            $decrypted = (string)ObjectManager::getInstance()
                ->get(EncryptorInterface::class)
                ->decrypt($value);
            if ($decrypted !== '') {
                $this->setValue($decrypted);
            }
        } catch (\Throwable $exception) {
            // Preserve the stored value if a legacy ciphertext cannot be
            // decrypted with this Magento installation's crypt key.
        }
    }

    public function beforeSave()
    {
        return parent::beforeSave();
    }
}
