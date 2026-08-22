<?php
declare(strict_types=1);

namespace Afd\AI\Model\Gateway;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\Encryption\EncryptorInterface;

/**
 * Owns the two long-lived credentials shared by Magento and the Node gateway.
 *
 * The values are deliberately visible to an administrator, but their lifecycle
 * is not delegated to a browser form. This avoids a harmless Admin Save
 * severing the trust relationship with a running Node service.
 */
class GatewaySecretManager
{
    private const MINIMUM_SECRET_LENGTH = 32;
    private const LEGACY_ENCRYPTED_VALUE_PATTERN = '/^\d+:\d+:[A-Za-z0-9+\/=]+$/';

    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly WriterInterface $configWriter,
        private readonly EncryptorInterface $encryptor
    ) {
    }

    public function getNodeSyncSecret(): string
    {
        return $this->getOrCreate(AiConfig::XML_PATH_NODE_SYNC_SECRET);
    }

    public function getWebSocketTicketSecret(): string
    {
        return $this->getOrCreate(AiConfig::XML_PATH_WS_TICKET_SECRET);
    }

    /**
     * Keep an already valid stored value exactly as it is. Legacy encrypted
     * values remain compatible until Magento saves a newly generated value.
     */
    public function preserveOrCreate(string $storedValue): string
    {
        $secret = $this->reveal($storedValue);
        if ($this->isValid($secret)) {
            return $this->isEncrypted($storedValue)
                ? $storedValue
                : $this->encryptor->encrypt($secret);
        }

        return $this->encryptor->encrypt($this->generate());
    }

    /**
     * Return a safely displayable value, including configuration written by
     * the earlier encrypted backend field implementation.
     */
    public function reveal(string $storedValue): string
    {
        if ($storedValue === '') {
            return '';
        }

        if (!preg_match(self::LEGACY_ENCRYPTED_VALUE_PATTERN, $storedValue)) {
            return $storedValue;
        }

        try {
            $decrypted = (string)$this->encryptor->decrypt($storedValue);
        } catch (\Throwable $exception) {
            return '';
        }

        return $this->isSafeText($decrypted) ? $decrypted : '';
    }

    public function isValid(string $secret): bool
    {
        return strlen($secret) >= self::MINIMUM_SECRET_LENGTH && $this->isSafeText($secret);
    }

    /** @return array{node_sync_secret: string, ws_ticket_secret: string} */
    public function getCredentials(): array
    {
        return [
            'node_sync_secret' => $this->getNodeSyncSecret(),
            'ws_ticket_secret' => $this->getWebSocketTicketSecret(),
        ];
    }

    private function getOrCreate(string $path): string
    {
        $storedValue = (string)$this->scopeConfig->getValue(
            $path,
            ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
            0
        );
        $secret = $this->reveal($storedValue);
        if (!$this->isValid($secret)) {
            $secret = $this->generate();
            $this->configWriter->save(
                $path,
                $this->encryptor->encrypt($secret),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );
        } elseif (!$this->isEncrypted($storedValue)) {
            // Migrate legacy plaintext installations on first read without
            // changing the credential exposed to the Node runtime.
            $this->configWriter->save(
                $path,
                $this->encryptor->encrypt($secret),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );
        }

        return $secret;
    }

    private function generate(): string
    {
        return bin2hex(random_bytes(32));
    }

    private function isSafeText(string $value): bool
    {
        return mb_check_encoding($value, 'UTF-8')
            && !preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value);
    }

    private function isEncrypted(string $value): bool
    {
        return preg_match(self::LEGACY_ENCRYPTED_VALUE_PATTERN, $value) === 1;
    }
}
