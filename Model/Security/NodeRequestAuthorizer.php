<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\App\CacheInterface;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Exception\AuthorizationException;
use Magento\Framework\Lock\LockManagerInterface;

/**
 * Authenticates internal Node -> Magento calls without relying on a Magento
 * OAuth integration. A signature is valid for only five minutes and binds the
 * HTTP method, request URI and original request body.
 */
class NodeRequestAuthorizer
{
    private const MAX_CLOCK_SKEW_SECONDS = 300;
    private const NONCE_CACHE_PREFIX = 'afd_ai_internal_nonce_';

    private RequestInterface $request;
    private AiConfig $aiConfig;
    private CacheInterface $cache;
    private LockManagerInterface $lockManager;

    public function __construct(
        RequestInterface $request,
        AiConfig $aiConfig,
        CacheInterface $cache,
        LockManagerInterface $lockManager
    ) {
        $this->request = $request;
        $this->aiConfig = $aiConfig;
        $this->cache = $cache;
        $this->lockManager = $lockManager;
    }

    /**
     * @throws AuthorizationException
     */
    public function assertAuthorized(): void
    {
        $secret = $this->aiConfig->getNodeSyncSecret();
        $timestamp = (string)$this->request->getHeader('X-Afd-AI-Internal-Timestamp');
        $nonce = strtolower((string)$this->request->getHeader('X-Afd-AI-Internal-Nonce'));
        $signature = (string)$this->request->getHeader('X-Afd-AI-Internal-Signature');
        $timestampValue = ctype_digit($timestamp) ? (int)$timestamp : 0;

        if (strlen($secret) < 32
            || $timestampValue === 0
            || abs(time() - $timestampValue) > self::MAX_CLOCK_SKEW_SECONDS
            || !preg_match('/^[a-f0-9]{32}$/', $nonce)
            || !preg_match('/^[a-f0-9]{64}$/i', $signature)) {
            throw new AuthorizationException(__('Unauthorized internal request.'));
        }

        $requestTarget = (string)$this->request->getRequestUri();
        $signedPayload = implode('.', [
            $timestamp,
            $nonce,
            strtoupper((string)$this->request->getMethod()),
            $requestTarget,
            (string)$this->request->getContent(),
        ]);
        $expectedSignature = hash_hmac('sha256', $signedPayload, $secret);

        if (!hash_equals($expectedSignature, strtolower($signature))) {
            throw new AuthorizationException(__('Unauthorized internal request.'));
        }

        $this->claimNonce($nonce);
    }

    /** @throws AuthorizationException */
    private function claimNonce(string $nonce): void
    {
        $cacheKey = self::NONCE_CACHE_PREFIX . hash('sha256', $nonce);
        $lockName = $cacheKey . '_lock';
        if (!$this->lockManager->lock($lockName, 2)) {
            throw new AuthorizationException(__('Unauthorized internal request.'));
        }

        try {
            if ($this->cache->load($cacheKey) !== false) {
                throw new AuthorizationException(__('Unauthorized internal request.'));
            }
            $this->cache->save('1', $cacheKey, [], self::MAX_CLOCK_SKEW_SECONDS);
        } finally {
            $this->lockManager->unlock($lockName);
        }
    }
}
