<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Afd\AI\Model\Catalog\ShopperScopeResolver;
use Afd\AI\Model\Catalog\PageContextResolver;
use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\Session\Config as SessionConfig;

class WebSocketTicketIssuer
{
    private const AUDIENCE = 'afd-ai-websocket';
    private const TTL_SECONDS = 60;
    public function __construct(
        private readonly AiConfig $config,
        private readonly SessionConfig $sessionConfig,
        private readonly CustomerSession $customerSession,
        private readonly ShopperScopeResolver $shopperScopeResolver,
        private readonly PageContextResolver $pageContextResolver,
        private readonly GuestChatIdentity $guestChatIdentity
    ) {
    }

    public function issue(?int $customerId, string $sessionId): string
    {
        $secret = $this->webSocketSecret();
        $guestHistoryId = !$customerId || $customerId < 1
            ? $this->guestChatIdentity->resolve()
            : null;
        $customerGroupId = $customerId && $customerId > 0
            ? (int)$this->customerSession->getCustomerGroupId()
            : 0;
        $shopperScope = $this->shopperScopeResolver->resolve($customerGroupId, (int)($customerId ?? 0));

        return $this->sign([
            'aud' => self::AUDIENCE,
            'sub' => $customerId && $customerId > 0 ? (string)$customerId : null,
            // The session fingerprint remains for rate limiting and checkout
            // operations only. It must never own persistent guest chat data.
            'sid' => hash('sha256', $sessionId),
            // SHA-256 digest of a random, HttpOnly chat cookie. Magento has
            // stored the digest before issuing this signed ticket; Node never
            // sees the raw browser token and never accepts it from a message.
            'gid' => $guestHistoryId,
            // The checkout session ID is encrypted for the trusted gateway.
            // The gateway receives it only after ticket verification and can
            // present it solely to the HMAC-protected internal cart route.
            'sct' => $this->encryptCheckoutSessionId($sessionId, $secret),
            'scn' => (string)$this->sessionConfig->getName(),
            // Store and group are resolved by Magento and signed into the
            // one-minute ticket. The browser never supplies pricing scope.
            'catalog_scope' => $shopperScope->toArray(),
            'page_context' => $this->pageContextResolver->resolve(),
        ]);
    }

    public function issueAdmin(int $adminId, string $adminName, string $sessionId): string
    {
        if ($adminId < 1 || trim($sessionId) === '') {
            throw new \InvalidArgumentException('A valid administrator session is required.');
        }

        return $this->sign([
            'aud' => self::AUDIENCE,
            'role' => 'support_admin',
            'aid' => $adminId,
            'name' => mb_substr(trim($adminName) ?: 'Support team', 0, 80),
            'sid' => hash('sha256', 'admin:' . $adminId . ':' . $sessionId),
        ]);
    }

    /** @param array<string, mixed> $claims */
    private function sign(array $claims): string
    {
        $secret = $this->webSocketSecret();

        $now = time();
        $header = $this->base64UrlEncode(json_encode([
            'alg' => 'HS256',
            'typ' => 'JWT',
        ], JSON_THROW_ON_ERROR));
        $payload = $this->base64UrlEncode(json_encode($claims + [
            'jti' => bin2hex(random_bytes(16)),
            'iat' => $now,
            'exp' => $now + self::TTL_SECONDS,
        ], JSON_THROW_ON_ERROR));
        $signature = $this->base64UrlEncode(hash_hmac('sha256', $header . '.' . $payload, $secret, true));

        return $header . '.' . $payload . '.' . $signature;
    }

    private function webSocketSecret(): string
    {
        $secret = $this->config->getWebSocketTicketSecret();
        if (strlen($secret) < 32) {
            throw new \RuntimeException('The Afd AI WebSocket ticket secret is not configured securely.');
        }

        return $secret;
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private function encryptCheckoutSessionId(string $sessionId, string $secret): string
    {
        $nonce = random_bytes(12);
        $tag = '';
        $key = hash_hmac('sha256', 'afd-ai-websocket-ticket-session-v1', $secret, true);
        $ciphertext = openssl_encrypt(
            $sessionId,
            'aes-256-gcm',
            $key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            self::AUDIENCE
        );

        if ($ciphertext === false || strlen($tag) !== 16) {
            throw new \RuntimeException('Could not secure the WebSocket session ticket.');
        }

        return $this->base64UrlEncode($nonce . $tag . $ciphertext);
    }
}
