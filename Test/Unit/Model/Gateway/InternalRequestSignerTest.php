<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Gateway;

use Afd\AI\Model\Gateway\InternalRequestSigner;
use PHPUnit\Framework\TestCase;

class InternalRequestSignerTest extends TestCase
{
    public function testSignatureBindsMethodPathAndBody(): void
    {
        $signer = new InternalRequestSigner();
        $secret = str_repeat('s', 32);
        $expected = hash_hmac(
            'sha256',
            '1720000000.POST./internal/config.{"version":2}',
            $secret
        );

        self::assertSame(
            $expected,
            $signer->signature($secret, '1720000000', 'post', '//internal//config', '{"version":2}')
        );
        self::assertNotSame(
            $expected,
            $signer->signature($secret, '1720000000', 'POST', '/internal/session-revoke', '{"version":2}')
        );
    }
}
