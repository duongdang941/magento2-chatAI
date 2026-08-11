<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Order;

use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Order\GuestOrderAccessRepository;
use Afd\AI\Model\Order\GuestOrderOtpSender;
use Afd\AI\Model\Order\GuestOrderVerification;
use Magento\Framework\Lock\LockManagerInterface;
use PHPUnit\Framework\TestCase;

class GuestOrderVerificationTest extends TestCase
{
    private const EMAIL = 'guest@example.com';
    private const SESSION_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    public function testRejectsInvalidInputBeforeTakingALock(): void
    {
        $lock = $this->createMock(LockManagerInterface::class);
        $lock->expects(self::never())->method('lock');
        $service = $this->createService(lock: $lock);

        $result = $service->requestOtp('not-an-email', self::SESSION_ID);

        self::assertSame('invalid_email', $result['reason']);
    }

    public function testCreatesAndSendsABoundedChallenge(): void
    {
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->method('findChallenge')->willReturn(null);
        $repository->method('getEmailSendStats')->willReturn([
            'send_count' => 0,
            'last_sent_at' => '',
        ]);
        $repository->expects(self::once())
            ->method('saveChallenge')
            ->with(
                self::callback(static function (array $data): bool {
                    return strlen((string)$data['code_hash']) === 64
                        && $data['send_count'] === 1
                        && $data['attempts'] === 0
                        && $data['access_token_hash'] === null;
                }),
                null
            );
        $sender = $this->createMock(GuestOrderOtpSender::class);
        $sender->expects(self::once())
            ->method('send')
            ->with(self::EMAIL, self::matchesRegularExpression('/^\d{6}$/'))
            ->willReturn(true);

        $result = $this->createService($repository, $sender)->requestOtp(self::EMAIL, self::SESSION_ID);

        self::assertSame('success', $result['status']);
    }

    public function testEmailBudgetCannotBeResetByChangingSession(): void
    {
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->method('findChallenge')->willReturn(null);
        $repository->method('getEmailSendStats')->willReturn([
            'send_count' => 3,
            'last_sent_at' => gmdate('Y-m-d H:i:s', time() - 120),
        ]);
        $repository->expects(self::never())->method('saveChallenge');
        $sender = $this->createMock(GuestOrderOtpSender::class);
        $sender->expects(self::never())->method('send');

        $result = $this->createService($repository, $sender)
            ->requestOtp(self::EMAIL, str_repeat('b', 64));

        self::assertSame('rate_limited', $result['reason']);
    }

    public function testReportsUnavailableEmailWithoutCreatingAChallenge(): void
    {
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->expects(self::never())->method('saveChallenge');
        $sender = $this->createMock(GuestOrderOtpSender::class);

        $result = $this->createService($repository, $sender, senderAvailable: false)
            ->requestOtp(self::EMAIL, self::SESSION_ID);

        self::assertSame('error', $result['status']);
        self::assertSame('email_delivery_unavailable', $result['reason']);
    }

    public function testInvalidCodeConsumesOneAttempt(): void
    {
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->method('findChallenge')->willReturn([
            'entity_id' => 12,
            'expires_at' => gmdate('Y-m-d H:i:s', time() + 300),
            'attempts' => 2,
            'code_hash' => str_repeat('0', 64),
        ]);
        $repository->expects(self::once())->method('incrementAttempts')->with(12, 3);

        $result = $this->createService($repository)->verifyOtp(self::EMAIL, '123456', self::SESSION_ID);

        self::assertSame('invalid_code', $result['reason']);
    }

    public function testAccessTokenIsBoundToEmailAndSession(): void
    {
        $token = str_repeat('a', 64);
        $repository = $this->createMock(GuestOrderAccessRepository::class);
        $repository->expects(self::once())
            ->method('findAccess')
            ->with(hash('sha256', $token), self::SESSION_ID)
            ->willReturn([
                'email_hash' => hash('sha256', self::EMAIL),
                'verified_at' => gmdate('Y-m-d H:i:s'),
                'access_expires_at' => gmdate('Y-m-d H:i:s', time() + 300),
            ]);

        self::assertTrue($this->createService($repository)->hasAccess(
            $token,
            self::SESSION_ID,
            self::EMAIL
        ));
    }

    private function createService(
        ?GuestOrderAccessRepository $repository = null,
        ?GuestOrderOtpSender $sender = null,
        ?LockManagerInterface $lock = null,
        bool $senderAvailable = true
    ): GuestOrderVerification {
        $config = $this->createMock(AiConfig::class);
        $config->method('getNodeSyncSecret')->willReturn(str_repeat('s', 32));
        $lock ??= $this->createMock(LockManagerInterface::class);
        $lock->method('lock')->willReturn(true);
        $sender ??= $this->createMock(GuestOrderOtpSender::class);
        $sender->method('isAvailable')->willReturn($senderAvailable);

        return new GuestOrderVerification(
            $config,
            $repository ?? $this->createMock(GuestOrderAccessRepository::class),
            $sender,
            $lock
        );
    }
}
