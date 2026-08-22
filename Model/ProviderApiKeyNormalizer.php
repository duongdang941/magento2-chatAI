<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Magento\Framework\Encryption\EncryptorInterface;

/** Handles legacy plaintext keys and ciphertext copied from another Magento crypt key. */
class ProviderApiKeyNormalizer
{
    private const MAX_KEY_BYTES = 8192;

    public function __construct(private readonly EncryptorInterface $encryptor)
    {
    }

    public function forDisplay(?string $storedValue): string
    {
        $value = (string)$storedValue;
        if ($value === '') {
            return '';
        }

        try {
            $decrypted = (string)$this->encryptor->decrypt($value);
            if ($this->isSafeText($decrypted)) {
                return $decrypted;
            }
        } catch (\Throwable) {
            // Legacy plaintext or ciphertext from another crypt key is handled below.
        }

        return $this->isSafeText($value) && !preg_match('/^\d+:\d+:/', $value)
            ? $value
            : '';
    }

    public function forStorage(string $value): string
    {
        if (!$this->isSafeText($value)) {
            throw new \InvalidArgumentException('The provider API key contains invalid characters.');
        }

        try {
            $decrypted = (string)$this->encryptor->decrypt($value);
            if ($this->isSafeText($decrypted) && $decrypted !== '' && $decrypted !== $value) {
                return $value;
            }
        } catch (\Throwable) {
            // Plaintext values are encrypted below.
        }

        return $this->encryptor->encrypt($value);
    }

    private function isSafeText(string $value): bool
    {
        return $value !== ''
            && strlen($value) <= self::MAX_KEY_BYTES
            && mb_check_encoding($value, 'UTF-8')
            && !preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value);
    }
}
