<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\Lock\LockManagerInterface;

/** Owns the email-OTP lifecycle and its short-lived access token. */
class GuestOrderVerification
{
    private const OTP_TTL = 600;
    private const ACCESS_TTL = 86400;
    private const MAX_SENDS = 3;
    private const SEND_WINDOW = 900;
    private const RESEND_COOLDOWN = 60;
    private const MAX_ATTEMPTS = 5;

    public function __construct(
        private readonly AiConfig $config,
        private readonly GuestOrderAccessRepository $repository,
        private readonly GuestOrderOtpSender $sender,
        private readonly LockManagerInterface $lockManager
    ) {
    }

    /** @return array<string, mixed> */
    public function requestOtp(string $email, string $sessionId): array
    {
        $email = $this->normalizeEmail($email);
        $sessionId = $this->normalizeSessionId($sessionId);
        if ($email === '' || $sessionId === '') {
            return $this->requiresAction('invalid_email', 'Please provide a valid email address.');
        }

        return $this->withLock(
            $email,
            $sessionId,
            fn (): array => $this->createChallenge($email, $sessionId),
            'Please wait before requesting another verification code.'
        );
    }

    /** @return array<string, mixed> */
    public function verifyOtp(string $email, string $code, string $sessionId): array
    {
        $email = $this->normalizeEmail($email);
        $sessionId = $this->normalizeSessionId($sessionId);
        $code = trim($code);
        if ($email === '' || $sessionId === '' || !preg_match('/^\d{6}$/', $code)) {
            return $this->requiresAction('invalid_code', 'Please enter the six-digit verification code.');
        }

        return $this->withLock(
            $email,
            $sessionId,
            fn (): array => $this->completeChallenge($email, $sessionId, $code),
            'Please wait before trying the verification code again.'
        );
    }

    public function hasAccess(string $token, string $sessionId, string $email): bool
    {
        return $this->findValidAccess($token, $sessionId, $email) !== null;
    }

    public function hasFreshAccess(string $token, string $sessionId, string $email): bool
    {
        $row = $this->findValidAccess($token, $sessionId, $email);
        return $row !== null
            && $this->utcTimestamp((string)$row['verified_at']) >= time() - self::ACCESS_TTL;
    }

    /** @return array<string, mixed>|null */
    private function findValidAccess(string $token, string $sessionId, string $email): ?array
    {
        $email = $this->normalizeEmail($email);
        $sessionId = $this->normalizeSessionId($sessionId);
        $token = strtolower(trim($token));
        if ($email === '' || $sessionId === '' || !preg_match('/^[a-f0-9]{64}$/', $token)) {
            return null;
        }

        $row = $this->repository->findAccess(hash('sha256', $token), $sessionId);
        if (!$row || $this->utcTimestamp((string)$row['access_expires_at']) < time()) {
            return null;
        }

        return hash_equals((string)$row['email_hash'], hash('sha256', $email)) ? $row : null;
    }

    /**
     * @param callable(): array<string, mixed> $operation
     * @return array<string, mixed>
     */
    private function withLock(
        string $email,
        string $sessionId,
        callable $operation,
        string $busyMessage
    ): array {
        // Serialize by email, not session. Rotating a browser session must not
        // reset the store-wide email delivery budget.
        $lockName = 'afd_ai_guest_otp_' . hash('sha256', $email);
        if (!$this->lockManager->lock($lockName, 2)) {
            return $this->requiresAction('rate_limited', $busyMessage);
        }

        try {
            return $operation();
        } finally {
            $this->lockManager->unlock($lockName);
        }
    }

    /** @return array<string, mixed> */
    private function createChallenge(string $email, string $sessionId): array
    {
        if (!$this->sender->isAvailable()) {
            return $this->emailUnavailableResponse();
        }

        $emailHash = hash('sha256', $email);
        $row = $this->repository->findChallenge($emailHash, $sessionId);
        $now = time();
        $emailStats = $this->repository->getEmailSendStats(
            $emailHash,
            gmdate('Y-m-d H:i:s', $now - self::SEND_WINDOW)
        );
        if ($emailStats['send_count'] >= self::MAX_SENDS) {
            return $this->requiresAction('rate_limited', 'Please wait before requesting another verification code.');
        }
        if ($this->utcTimestamp($emailStats['last_sent_at']) > $now - self::RESEND_COOLDOWN) {
            return $this->sentResponse();
        }

        $lastSentAt = $row ? $this->utcTimestamp((string)$row['created_at']) : 0;
        $sendCount = $lastSentAt > $now - self::SEND_WINDOW ? (int)$row['send_count'] : 0;

        $code = (string)random_int(100000, 999999);
        $this->repository->saveChallenge([
            'email_hash' => $emailHash,
            'session_id' => $sessionId,
            'code_hash' => $this->codeHash($emailHash, $sessionId, $code),
            'access_token_hash' => null,
            'send_count' => $sendCount + 1,
            'attempts' => 0,
            'expires_at' => gmdate('Y-m-d H:i:s', $now + self::OTP_TTL),
            'verified_at' => null,
            'access_expires_at' => null,
            'created_at' => gmdate('Y-m-d H:i:s', $now),
        ], $row ? (int)$row['entity_id'] : null);

        if (!$this->sender->send($email, $code)) {
            $savedRow = $this->repository->findChallenge($emailHash, $sessionId);
            $this->repository->deleteChallenge((int)($savedRow['entity_id'] ?? 0));
            return $this->emailUnavailableResponse();
        }

        return $this->sentResponse();
    }

    /** @return array<string, mixed> */
    private function completeChallenge(string $email, string $sessionId, string $code): array
    {
        $emailHash = hash('sha256', $email);
        $row = $this->repository->findChallenge($emailHash, $sessionId);
        if (!$row
            || $this->utcTimestamp((string)$row['expires_at']) < time()
            || (int)$row['attempts'] >= self::MAX_ATTEMPTS
        ) {
            return $this->requiresAction('invalid_code', 'That code is invalid or expired. Request a new code.');
        }

        if (!hash_equals((string)$row['code_hash'], $this->codeHash($emailHash, $sessionId, $code))) {
            $this->repository->incrementAttempts((int)$row['entity_id'], (int)$row['attempts'] + 1);
            return $this->requiresAction('invalid_code', 'That code is invalid or expired.');
        }

        $accessToken = bin2hex(random_bytes(32));
        $accessExpiresAt = time() + self::ACCESS_TTL;
        $this->repository->grantAccess((int)$row['entity_id'], [
            'attempts' => self::MAX_ATTEMPTS,
            'access_token_hash' => hash('sha256', $accessToken),
            'verified_at' => gmdate('Y-m-d H:i:s'),
            'access_expires_at' => gmdate('Y-m-d H:i:s', $accessExpiresAt),
        ]);

        return [
            'status' => 'success',
            'access_token' => $accessToken,
            'expires_in' => self::ACCESS_TTL,
            'expires_at' => $accessExpiresAt,
        ];
    }

    private function codeHash(string $emailHash, string $sessionId, string $code): string
    {
        return hash_hmac('sha256', $emailHash . '|' . $sessionId . '|' . $code, $this->config->getNodeSyncSecret());
    }

    private function normalizeEmail(string $email): string
    {
        $email = mb_strtolower(trim($email));
        return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
    }

    private function normalizeSessionId(string $sessionId): string
    {
        $sessionId = strtolower(trim($sessionId));
        return preg_match('/^[a-f0-9]{64}$/', $sessionId) ? $sessionId : '';
    }

    private function utcTimestamp(string $value): int
    {
        $date = \DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s',
            $value,
            new \DateTimeZone('UTC')
        );

        return $date instanceof \DateTimeImmutable ? $date->getTimestamp() : 0;
    }

    /** @return array<string, string> */
    private function sentResponse(): array
    {
        return [
            'status' => 'success',
            'message' => 'Verification code sent. Check your inbox and spam folder.',
        ];
    }

    /** @return array<string, string> */
    private function emailUnavailableResponse(): array
    {
        return [
            'status' => 'error',
            'reason' => 'email_delivery_unavailable',
            'message' => 'The verification email could not be sent. Please try again later or contact support.',
        ];
    }

    /** @return array<string, string> */
    private function requiresAction(string $reason, string $message): array
    {
        return [
            'status' => 'requires_customer_action',
            'reason' => $reason,
            'message' => $message,
        ];
    }
}
