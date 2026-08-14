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
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->expects(self::exactly(2))
            ->method('getValue')
            ->with(AiConfig::XML_PATH_NODE_SYNC_SECRET, ScopeConfigInterface::SCOPE_TYPE_DEFAULT, 0)
            ->willReturn($secret);
        $writer = $this->createMock(WriterInterface::class);
        $writer->expects(self::never())->method('save');

        $manager = new GatewaySecretManager(
            $scopeConfig,
            $writer,
            $this->createMock(EncryptorInterface::class)
        );

        self::assertSame($secret, $manager->getNodeSyncSecret());
        self::assertSame($secret, $manager->getNodeSyncSecret());
    }

    public function testRegeneratesMissingSecretAndReturnsThePersistedValue(): void
    {
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->expects(self::once())->method('getValue')->willReturn('');
        $writer = $this->createMock(WriterInterface::class);
        $writer->expects(self::once())
            ->method('save')
            ->with(
                AiConfig::XML_PATH_WS_TICKET_SECRET,
                self::callback(static fn (string $value): bool => strlen($value) === 64 && ctype_xdigit($value)),
                ScopeConfigInterface::SCOPE_TYPE_DEFAULT,
                0
            );

        $manager = new GatewaySecretManager(
            $scopeConfig,
            $writer,
            $this->createMock(EncryptorInterface::class)
        );

        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $manager->getWebSocketTicketSecret());
    }

    public function testPreserveOrCreateIgnoresSubmittedAdminValue(): void
    {
        $manager = new GatewaySecretManager(
            $this->createMock(ScopeConfigInterface::class),
            $this->createMock(WriterInterface::class),
            $this->createMock(EncryptorInterface::class)
        );
        $existingSecret = str_repeat('b', 64);

        self::assertSame($existingSecret, $manager->preserveOrCreate($existingSecret));
        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $manager->preserveOrCreate(''));
    }
}
