<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Security;

use Afd\AI\Model\Security\ActionRateLimiter;
use Magento\Framework\App\CacheInterface;
use Magento\Framework\Lock\LockManagerInterface;
use PHPUnit\Framework\TestCase;

class ActionRateLimiterTest extends TestCase
{
    public function testAllowsUntilLimitAndThenReturnsRetryTime(): void
    {
        $stored = false;
        $cache = $this->createMock(CacheInterface::class);
        $cache->method('load')->willReturnCallback(static function () use (&$stored) { return $stored; });
        $cache->method('save')->willReturnCallback(static function (string $value) use (&$stored): bool {
            $stored = $value;
            return true;
        });
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(true);

        $limiter = new ActionRateLimiter($cache, $lock);
        self::assertTrue($limiter->consume('feedback', 'customer:1', 2, 60)['allowed']);
        self::assertTrue($limiter->consume('feedback', 'customer:1', 2, 60)['allowed']);
        $blocked = $limiter->consume('feedback', 'customer:1', 2, 60);
        self::assertFalse($blocked['allowed']);
        self::assertGreaterThan(0, $blocked['retry_after']);
    }
}
