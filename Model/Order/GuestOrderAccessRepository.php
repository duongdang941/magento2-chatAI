<?php
declare(strict_types=1);

namespace Afd\AI\Model\Order;

use Magento\Framework\App\ResourceConnection;

/** Database persistence for guest-order verification challenges. */
class GuestOrderAccessRepository
{
    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    /** @return array<string, mixed>|null */
    public function findChallenge(string $emailHash, string $sessionId): ?array
    {
        $connection = $this->resource->getConnection();
        $row = $connection->fetchRow(
            $connection->select()
                ->from($this->tableName())
                ->where('email_hash = ?', $emailHash)
                ->where('session_id = ?', $sessionId)
        );

        return is_array($row) ? $row : null;
    }

    /** @return array{send_count:int,last_sent_at:string} */
    public function getEmailSendStats(string $emailHash, string $createdAfter): array
    {
        $connection = $this->resource->getConnection();
        $row = $connection->fetchRow(
            $connection->select()
                ->from($this->tableName(), [
                    'send_count' => new \Zend_Db_Expr('COALESCE(SUM(send_count), 0)'),
                    'last_sent_at' => new \Zend_Db_Expr("COALESCE(MAX(created_at), '')"),
                ])
                ->where('email_hash = ?', $emailHash)
                ->where('created_at >= ?', $createdAfter)
        );

        return [
            'send_count' => max(0, (int)($row['send_count'] ?? 0)),
            'last_sent_at' => (string)($row['last_sent_at'] ?? ''),
        ];
    }

    /** @param array<string, mixed> $data */
    public function saveChallenge(array $data, ?int $entityId = null): void
    {
        $connection = $this->resource->getConnection();
        if ($entityId !== null) {
            $connection->update($this->tableName(), $data, ['entity_id = ?' => $entityId]);
            return;
        }

        $connection->insert($this->tableName(), $data);
    }

    public function incrementAttempts(int $entityId, int $attempts): void
    {
        $this->resource->getConnection()->update(
            $this->tableName(),
            ['attempts' => $attempts],
            ['entity_id = ?' => $entityId]
        );
    }

    public function deleteChallenge(int $entityId): void
    {
        if ($entityId < 1) {
            return;
        }
        $this->resource->getConnection()->delete(
            $this->tableName(),
            ['entity_id = ?' => $entityId]
        );
    }

    /** @param array<string, mixed> $data */
    public function grantAccess(int $entityId, array $data): void
    {
        $this->resource->getConnection()->update(
            $this->tableName(),
            $data,
            ['entity_id = ?' => $entityId]
        );
    }

    /** @return array<string, mixed>|null */
    public function findAccess(string $tokenHash, string $sessionId): ?array
    {
        $connection = $this->resource->getConnection();
        $row = $connection->fetchRow(
            $connection->select()
                ->from($this->tableName(), ['email_hash', 'verified_at', 'access_expires_at'])
                ->where('access_token_hash = ?', $tokenHash)
                ->where('session_id = ?', $sessionId)
        );

        return is_array($row) ? $row : null;
    }

    public function deleteExpired(string $cutoff): int
    {
        return $this->resource->getConnection()->delete(
            $this->tableName(),
            [
                'expires_at < ?' => $cutoff,
                '(access_expires_at IS NULL OR access_expires_at < ?)' => $cutoff,
            ]
        );
    }

    private function tableName(): string
    {
        return $this->resource->getTableName('afd_ai_guest_order_access');
    }
}
