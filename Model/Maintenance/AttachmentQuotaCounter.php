<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Exception\LocalizedException;

/** Atomic per-owner attachment byte reservations backed by MySQL row locks. */
class AttachmentQuotaCounter
{
    private const TABLE = 'afd_ai_attachment_quota';

    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    public function isInitialized(string $ownerPath): bool
    {
        $connection = $this->resource->getConnection();
        return (bool)$connection->fetchOne($connection->select()->from(
            $this->resource->getTableName(self::TABLE), ['scope_id']
        )->where('scope_type = ?', 'owner')->where('scope_key = ?', $ownerPath));
    }

    public function initializeOwner(string $ownerPath, int $usedBytes): void
    {
        $this->upsertOwner($ownerPath, max(0, $usedBytes));
    }

    public function reserve(string $ownerPath, int $maximumBytes, int $bytes, ?int $maximumGlobalBytes = null): void
    {
        $bytes = max(0, $bytes);
        $maximumBytes = max(0, $maximumBytes);
        if ($bytes === 0) {
            return;
        }

        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        $connection->beginTransaction();
        try {
            $this->upsertOwner($ownerPath, 0);
            if ($maximumGlobalBytes !== null) {
                $this->upsertGlobal(0);
            }
            $row = $connection->fetchRow($connection->select()->from($table)
                ->where('scope_type = ?', 'owner')->where('scope_key = ?', $ownerPath)
                ->forUpdate(true));
            $used = (int)($row['used_bytes'] ?? 0);
            $reserved = (int)($row['reserved_bytes'] ?? 0);
            $globalRow = null;
            if ($maximumGlobalBytes !== null) {
                $globalRow = $connection->fetchRow($connection->select()->from($table)
                    ->where('scope_type = ?', 'global')->where('scope_key = ?', 'module')->forUpdate(true));
                if ((int)$globalRow['used_bytes'] + (int)$globalRow['reserved_bytes'] + $bytes > max(0, $maximumGlobalBytes)) {
                    throw new LocalizedException(__('The chat attachment storage limit has been reached.'));
                }
            }
            if ($used + $reserved + $bytes > $maximumBytes) {
                throw new LocalizedException(__('This shopper has reached the chat attachment storage limit.'));
            }
            $connection->update($table, [
                'reserved_bytes' => $reserved + $bytes,
                'updated_at' => gmdate('Y-m-d H:i:s'),
            ], ['scope_id = ?' => (int)$row['scope_id']]);
            if ($globalRow) {
                $connection->update($table, [
                    'reserved_bytes' => (int)$globalRow['reserved_bytes'] + $bytes,
                    'updated_at' => gmdate('Y-m-d H:i:s'),
                ], ['scope_id = ?' => (int)$globalRow['scope_id']]);
            }
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }

    public function commit(string $ownerPath, int $bytes): void
    {
        $this->moveReserved($ownerPath, $bytes, true);
    }

    public function releaseReservation(string $ownerPath, int $bytes): void
    {
        $this->moveReserved($ownerPath, $bytes, false);
    }

    public function releaseUsed(string $ownerPath, int $bytes): void
    {
        $bytes = max(0, $bytes);
        if ($bytes === 0) {
            return;
        }
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        $connection->beginTransaction();
        try {
            $row = $connection->fetchRow($connection->select()->from($table)
                ->where('scope_type = ?', 'owner')->where('scope_key = ?', $ownerPath)
                ->forUpdate(true));
            if ($row) {
                $connection->update($table, [
                    'used_bytes' => max(0, (int)$row['used_bytes'] - $bytes),
                    'updated_at' => gmdate('Y-m-d H:i:s'),
                ], ['scope_id = ?' => (int)$row['scope_id']]);
                $global = $connection->fetchRow($connection->select()->from($table)
                    ->where('scope_type = ?', 'global')->where('scope_key = ?', 'module')->forUpdate(true));
                if ($global) {
                    $connection->update($table, [
                        'used_bytes' => max(0, (int)$global['used_bytes'] - $bytes),
                        'updated_at' => gmdate('Y-m-d H:i:s'),
                    ], ['scope_id = ?' => (int)$global['scope_id']]);
                }
            }
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }

    private function moveReserved(string $ownerPath, int $bytes, bool $toUsed): void
    {
        $bytes = max(0, $bytes);
        if ($bytes === 0) {
            return;
        }
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        $connection->beginTransaction();
        try {
            $row = $connection->fetchRow($connection->select()->from($table)
                ->where('scope_type = ?', 'owner')->where('scope_key = ?', $ownerPath)
                ->forUpdate(true));
            if ($row) {
                $reserved = max(0, (int)$row['reserved_bytes'] - $bytes);
                $values = ['reserved_bytes' => $reserved, 'updated_at' => gmdate('Y-m-d H:i:s')];
                if ($toUsed) {
                    $values['used_bytes'] = (int)$row['used_bytes'] + $bytes;
                }
                $connection->update($table, $values, ['scope_id = ?' => (int)$row['scope_id']]);
                $global = $connection->fetchRow($connection->select()->from($table)
                    ->where('scope_type = ?', 'global')->where('scope_key = ?', 'module')->forUpdate(true));
                if ($global) {
                    $globalValues = ['reserved_bytes' => max(0, (int)$global['reserved_bytes'] - $bytes), 'updated_at' => gmdate('Y-m-d H:i:s')];
                    if ($toUsed) { $globalValues['used_bytes'] = (int)$global['used_bytes'] + $bytes; }
                    $connection->update($table, $globalValues, ['scope_id = ?' => (int)$global['scope_id']]);
                }
            }
            $connection->commit();
        } catch (\Throwable $exception) {
            $connection->rollBack();
            throw $exception;
        }
    }

    public function isGlobalInitialized(): bool
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        return (bool)$connection->fetchOne($connection->select()->from($table, ['scope_id'])
            ->where('scope_type = ?', 'global')->where('scope_key = ?', 'module')->limit(1));
    }

    public function initializeGlobal(int $usedBytes): void
    {
        $this->upsertGlobal(max(0, $usedBytes));
    }

    private function upsertGlobal(int $usedBytes): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        $connection->insertOnDuplicate($table, [
            'scope_type' => 'global',
            'scope_key' => 'module',
            'used_bytes' => max(0, $usedBytes),
            'reserved_bytes' => 0,
            'updated_at' => gmdate('Y-m-d H:i:s'),
        ], ['updated_at']);
    }

    private function upsertOwner(string $ownerPath, int $usedBytes): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE);
        $connection->insertOnDuplicate($table, [
            'scope_type' => 'owner',
            'scope_key' => $ownerPath,
            'used_bytes' => max(0, $usedBytes),
            'reserved_bytes' => 0,
            'updated_at' => gmdate('Y-m-d H:i:s'),
        ], ['updated_at']);
    }
}
