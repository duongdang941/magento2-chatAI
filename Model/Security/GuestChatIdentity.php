<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Session\Config as SessionConfig;
use Magento\Framework\Stdlib\Cookie\CookieMetadata;
use Magento\Framework\Stdlib\Cookie\CookieMetadataFactory;
use Magento\Framework\Stdlib\CookieManagerInterface;

/**
 * Owns the durable anonymous identity used by storefront chat.
 *
 * The browser holds an opaque random bearer token in a Secure, HttpOnly
 * cookie. Magento persists and exposes only its SHA-256 digest, so the raw
 * token never reaches the gateway or the conversation database.
 */
class GuestChatIdentity
{
    public const COOKIE_NAME = 'afd_ai_guest_token';
    private const COOKIE_LIFETIME = 63072000; // 730 days
    private const TOKEN_PATTERN = '/^[A-Za-z0-9_-]{43}$/D';

    public function __construct(
        private readonly CookieManagerInterface $cookieManager,
        private readonly CookieMetadataFactory $cookieMetadataFactory,
        private readonly SessionConfig $sessionConfig,
        private readonly ResourceConnection $resourceConnection
    ) {
    }

    /**
     * Returns the database-safe guest identity for this browser.
     *
     * @throws \RuntimeException when the identity cannot be persisted safely.
     */
    public function resolve(): string
    {
        try {
            $token = trim((string)$this->cookieManager->getCookie(self::COOKIE_NAME));
            $connection = $this->resourceConnection->getConnection();
            $identity = preg_match(self::TOKEN_PATTERN, $token)
                ? hash('sha256', $token)
                : '';
            if ($identity === '' || !$this->exists($connection, $identity)) {
                $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
                $identity = hash('sha256', $token);
            }

            // Renew on each secure ticket issuance. This behaves like the
            // standard storefront session cookie while remaining independent
            // from it, and preserves active guests for the full lifetime.
            $this->cookieManager->setSensitiveCookie(
                self::COOKIE_NAME,
                $token,
                $this->cookieMetadataFactory->createSensitiveCookieMetadata([
                    CookieMetadata::KEY_DURATION => self::COOKIE_LIFETIME,
                    CookieMetadata::KEY_PATH => $this->sessionConfig->getCookiePath(),
                    CookieMetadata::KEY_DOMAIN => $this->sessionConfig->getCookieDomain(),
                    CookieMetadata::KEY_SECURE => $this->sessionConfig->getCookieSecure(),
                    CookieMetadata::KEY_SAME_SITE => $this->sessionConfig->getCookieSameSite(),
                ])
            );
            // The request cookie bag is not updated after Set-Cookie. This
            // keeps multiple ticket issuances in this response consistent.
            $_COOKIE[self::COOKIE_NAME] = $token;
            $connection->insertOnDuplicate(
                $this->resourceConnection->getTableName('afd_ai_guest_identity'),
                [
                    'token_hash' => $identity,
                    'last_seen_at' => gmdate('Y-m-d H:i:s'),
                ],
                ['last_seen_at']
            );
        } catch (\Throwable $exception) {
            throw new \RuntimeException('The guest chat identity could not be saved.', 0, $exception);
        }

        return $identity;
    }

    private function exists(object $connection, string $identity): bool
    {
        try {
            $select = $connection->select()
                ->from($this->resourceConnection->getTableName('afd_ai_guest_identity'), ['token_hash'])
                ->where('token_hash = ?', $identity)
                ->limit(1);
            return $connection->fetchOne($select) !== false;
        } catch (\Throwable) {
            // A lookup failure is handled by the subsequent write, which
            // emits a controlled error instead of trusting an unknown token.
            return false;
        }
    }
}
