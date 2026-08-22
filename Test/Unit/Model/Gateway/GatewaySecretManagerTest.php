<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Gateway;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Gateway\GatewaySecretManager;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use PHPUnit\Framework\TestCase;

class GatewaySecretManagerTest extends TestCase
{
    public function testUsesExistingValidSecretWithoutWritingAnotherOne(): void
    {
        $secret = str_repeat('a', 64);
        $storedValue = '0:3:' . base64_encode($secret);
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->expects(self::exactly(2))
            ->method('getValue')
            ->with(AiConfig::XML_PATH_NODE_SYNC_SECRET, ScopeConfigInterface::SCOPE_TYPE_DEFAULT, 0)
            ->willReturn($storedValue);
        $writer = $this->createMock(WriterInterface::class);
        $writer->expects(self::never())->method('save');
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->expects(self::exactly(2))->method('decrypt')->with($storedValue)->willReturn($secret);

        $manager = new GatewaySecretManager(
            $scopeConfig,
            $writer,
            $encryptor
        );

        self::assertSame($secret, $manager->getNodeSyncSecret());
        self::assertSame($secret, $manager->getNodeSyncSecret());
    }

    public function testRegeneratesMissingSecretAndReturnsThePersistedValue(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->expects(self::once())->method('getValue')->willReturn('');
        $writer = $this->createMock(WriterInterface::class);
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->expects(self::once())
            ->method('encrypt')
            ->willReturnCallback(static fn (string $value): string => '0:3:' . base64_encode($value));
        $writer->expects(self::once())
            ->method('save')
            ->with(
                AiConfig::XML_PATH_WS_TICKET_SECRET,
                self::callback(static fn (string $value): bool => str_starts_with($value, '0:3:')),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );

        $manager = new GatewaySecretManager(
            $scopeConfig,
            $writer,
            $encryptor
        );

        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $manager->getWebSocketTicketSecret());
    }

    public function testPreserveOrCreateIgnoresSubmittedAdminValue(): void
    {
        $storedValue = '0:3:' . base64_encode(str_repeat('b', 64));
        $encryptor = $this->createMock(EncryptorInterface::class);
        $encryptor->expects(self::once())
            ->method('decrypt')
            ->with($storedValue)
            ->willReturn(str_repeat('b', 64));
        $encryptor->expects(self::once())
            ->method('encrypt')
            ->willReturnCallback(static fn (string $value): string => '0:3:' . base64_encode($value));
        $manager = new GatewaySecretManager(
            $this->createMock(ScopeConfigInterface::class),
            $this->createMock(WriterInterface::class),
            $encryptor
        );
        self::assertSame($storedValue, $manager->preserveOrCreate($storedValue));
        self::assertMatchesRegularExpression('/^0:3:[A-Za-z0-9+\/=]+$/', $manager->preserveOrCreate(''));
    }
}
