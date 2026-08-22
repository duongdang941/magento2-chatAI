<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model;

use Afd\AI\Model\ProviderApiKeyNormalizer;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;

class ProviderApiKeyNormalizerTest extends TestCase
{
    public function testLegacyPlaintextIsDisplayedAndEncryptedOnSave(): void
    {
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->method('decrypt')->willReturn("\xFF\xFEinvalid");
        $encryptor->expects(self::once())->method('encrypt')->with('sk-test-12345')->willReturn('ciphertext');
        $normalizer = new ProviderApiKeyNormalizer($encryptor);

        self::assertSame('sk-test-12345', $normalizer->forDisplay('sk-test-12345'));
        self::assertSame('ciphertext', $normalizer->forStorage('sk-test-12345'));
    }

    public function testValidCiphertextIsPreservedAndDisplayedDecrypted(): void
    {
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->method('decrypt')->willReturn('sk-valid');
        $encryptor->expects(self::never())->method('encrypt');
        $normalizer = new ProviderApiKeyNormalizer($encryptor);

        self::assertSame('sk-valid', $normalizer->forDisplay('ciphertext'));
        self::assertSame('ciphertext', $normalizer->forStorage('ciphertext'));
    }

    public function testRejectsAnUnboundedApiKeyBeforeEncryption(): void
    {
        $normalizer = new ProviderApiKeyNormalizer($this->createMock(EncryptorInterface::class));
        $this->expectException(\InvalidArgumentException::class);
        $normalizer->forStorage(str_repeat('x', 8193));
    }
}
