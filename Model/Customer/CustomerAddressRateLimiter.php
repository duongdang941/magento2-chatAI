<?php
declare(strict_types=1);

namespace Afd\AI\Model\Customer;

use Afd\AI\Model\Security\ActionRateLimiter;

/** Defense-in-depth throttle behind the HMAC-only Node endpoint. */
class CustomerAddressRateLimiter
{
    private const LIMITS = [
        'minute' => ['limit' => 5, 'seconds' => 60],
        'hour' => ['limit' => 20, 'seconds' => 3600],
    ];

    public function __construct(private readonly ActionRateLimiter $rateLimiter)
    {
    }

    /** @return array{allowed:bool,retry_after:int} */
    public function consume(int $customerId): array
    {
        $retryAfter = 0;
        foreach (self::LIMITS as $window => $settings) {
            $result = $this->rateLimiter->consume(
                'customer_address_' . $window,
                'customer:' . $customerId,
                $settings['limit'],
                $settings['seconds']
            );
            if (!$result['allowed']) {
                $retryAfter = max($retryAfter, $result['retry_after']);
            }
        }

        return ['allowed' => $retryAfter === 0, 'retry_after' => $retryAfter];
    }
}
