<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Security;

use Afd\AI\Model\Config\Config;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Magento\Framework\App\CacheInterface;
use Magento\Framework\App\Request\Http;
use Magento\Framework\Exception\AuthorizationException;
use Magento\Framework\Lock\LockManagerInterface;
use PHPUnit\Framework\TestCase;

class NodeRequestAuthorizerTest extends TestCase
{
    public function testAcceptsNonceOnceAndRejectsReplay(): void
    {
        $secret = 'node-request-authorizer-test-secret-value';
        $timestamp = (string)time();
        $nonce = str_repeat('a', 32);
        $method = 'POST';
        $uri = '/rest/V1/afd-ai/conversations/touch';
        $body = '{"conversationId":7}';
        $signature = hash_hmac('sha256', implode('.', [$timestamp, $nonce, $method, $uri, $body]), $secret);

        $request = $this->getMockBuilder(Http::class)->disableOriginalConstructor()->onlyMethods([
            'getHeader', 'getMethod', 'getRequestUri', 'getContent'
        ])->getMock();
        $request->method('getHeader')->willReturnCallback(static fn (string $name): string => match ($name) {
            'X-Afd-AI-Internal-Timestamp' => $timestamp,
            'X-Afd-AI-Internal-Nonce' => $nonce,
            'X-Afd-AI-Internal-Signature' => $signature,
            default => '',
        });
        $request->method('getMethod')->willReturn($method);
        $request->method('getRequestUri')->willReturn($uri);
        $request->method('getContent')->willReturn($body);

        $config = $this->getMockBuilder(Config::class)->disableOriginalConstructor()->onlyMethods(['getNodeSyncSecret'])->getMock();
        $config->method('getNodeSyncSecret')->willReturn($secret);
        $claimed = false;
        $cache = $this->createMock(CacheInterface::class);
        $cache->method('load')->willReturnCallback(static function () use (&$claimed) {
            return $claimed ? '1' : false;
        });
        $cache->method('save')->willReturnCallback(static function () use (&$claimed): bool {
            $claimed = true;
            return true;
        });
        $lockManager = $this->createMock(LockManagerInterface::class);
        $lockManager->method('lock')->willReturn(true);

        $authorizer = new NodeRequestAuthorizer($request, $config, $cache, $lockManager);
        $authorizer->assertAuthorized();

        $this->expectException(AuthorizationException::class);
        $authorizer->assertAuthorized();
    }
}
