<?php
declare(strict_types=1);

namespace Afd\AI\Model\Security;

use Magento\Framework\App\CacheInterface;
use Magento\Framework\Lock\LockManagerInterface;

/** Shared, lock-protected throttle for customer-visible AI mutations. */
class ActionRateLimiter
{
    public function __construct(
        private readonly CacheInterface $cache,
        private readonly LockManagerInterface $lockManager
    ) {
    }

    /** @return array{allowed:bool,retry_after:int} */
    public function consume(string $action, string $identity, int $limit, int $windowSeconds): array
    {
        $action = preg_replace('/[^a-z0-9_-]/i', '', strtolower($action)) ?: 'action';
        $identity = trim($identity);
        $limit = max(1, min($limit, 100));
        $windowSeconds = max(10, min($windowSeconds, 86400));
        $key = 'afd_ai_rate_' . hash('sha256', $action . ':' . $identity);
        $lock = $key . '_lock';
        if (!$this->lockManager->lock($lock, 2)) {
            return ['allowed' => false, 'retry_after' => 2];
        }

        try {
            $now = time();
            $record = json_decode((string)$this->cache->load($key), true);
            if (!is_array($record) || (int)($record['expires_at'] ?? 0) <= $now) {
                $record = ['count' => 0, 'expires_at' => $now + $windowSeconds];
            }
            $record['count'] = (int)$record['count'] + 1;
            $ttl = max(1, (int)$record['expires_at'] - $now);
            $this->cache->save((string)json_encode($record), $key, [], $ttl);

            return [
                'allowed' => (int)$record['count'] <= $limit,
                'retry_after' => (int)$record['count'] <= $limit ? 0 : $ttl,
            ];
        } finally {
            $this->lockManager->unlock($lock);
        }
    }
}
