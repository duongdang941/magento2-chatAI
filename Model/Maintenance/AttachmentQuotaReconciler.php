<?php
declare(strict_types=1);
namespace Afd\AI\Model\Maintenance;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\WriteInterface;
use Magento\Framework\Lock\LockManagerInterface;
use Psr\Log\LoggerInterface;

/** Repairs quota counters from the authoritative attachment filesystem. */
class AttachmentQuotaReconciler
{
    private const ATTACHMENT_PATH = 'afd_ai/chat';
    private const FILE_PATTERN = '#^afd_ai/chat/(?:\d+|guest/[a-f0-9]{64})/\d+/[a-f0-9]{40}\.(?:jpg|png|webp)$#D';
    private const WRITE_LOCK = 'afd_ai_attachment_write';
    private const LOCK_TIMEOUT_SECONDS = 5;

    public function __construct(
        private readonly Filesystem $filesystem,
        private readonly ResourceConnection $resource,
        private readonly LockManagerInterface $lockManager,
        private readonly LoggerInterface $logger
    ) {
    }

    /** @return array{reconciled:bool,owners:int,global_bytes:int,corrected:int} */
    public function execute(): array
    {
        if (!$this->lockManager->lock(self::WRITE_LOCK, self::LOCK_TIMEOUT_SECONDS)) {
            $this->logger->notice('Afd AI quota reconciliation skipped because attachment writes are busy.');
            return ['reconciled' => false, 'owners' => 0, 'global_bytes' => 0, 'corrected' => 0];
        }

        try {
            $directory = $this->filesystem->getDirectoryWrite(DirectoryList::VAR_DIR);
            $connection = $this->resource->getConnection();
            $table = $this->resource->getTableName('afd_ai_attachment_quota');
            $rows = $connection->fetchAll(
                $connection->select()->from($table)->where('scope_type = ?', 'owner')
            );
            $ownerUsage = [];
            foreach ($rows as $row) {
                $owner = trim((string)($row['scope_key'] ?? ''), '/');
                if ($owner !== '') {
                    $ownerUsage[$owner] = $this->scanOwnerBytes($directory, $owner);
                }
            }
            $globalUsage = $this->scanAllBytes($directory);

            $connection->beginTransaction();
            try {
                $corrected = 0;
                foreach ($rows as $row) {
                    $owner = trim((string)($row['scope_key'] ?? ''), '/');
                    if ($owner === '' || !array_key_exists($owner, $ownerUsage)) {
                        continue;
                    }
                    $actual = $ownerUsage[$owner];
                    if ((int)$row['used_bytes'] !== $actual) {
                        $corrected++;
                    }
                    // Reservations belong to in-flight uploads and must survive reconciliation.
                    $connection->update($table, [
                        'used_bytes' => $actual,
                        'updated_at' => gmdate('Y-m-d H:i:s'),
                    ], ['scope_id = ?' => (int)$row['scope_id']]);
                }

                $global = $connection->fetchRow($connection->select()->from($table)
                    ->where('scope_type = ?', 'global')
                    ->where('scope_key = ?', 'module')
                    ->forUpdate(true));
                if ($global) {
                    if ((int)$global['used_bytes'] !== $globalUsage) {
                        $corrected++;
                    }
                    $connection->update($table, [
                        'used_bytes' => $globalUsage,
                        'updated_at' => gmdate('Y-m-d H:i:s'),
                    ], ['scope_id = ?' => (int)$global['scope_id']]);
                } else {
                    $connection->insert($table, [
                        'scope_type' => 'global',
                        'scope_key' => 'module',
                        'used_bytes' => $globalUsage,
                        'reserved_bytes' => 0,
                        'updated_at' => gmdate('Y-m-d H:i:s'),
                    ]);
                    $corrected++;
                }

                // Reconcile and release stale/expired reservations (> 10 minutes)
                $resTable = $this->resource->getTableName('afd_ai_attachment_reservation');
                $attTable = $this->resource->getTableName('afd_ai_attachment');
                if ($connection->isTableExists($resTable)) {
                    $expiredReservations = $connection->fetchAll(
                        $connection->select()->from($resTable)
                            ->where('state = ?', 'active')
                            ->where('expires_at < ?', gmdate('Y-m-d H:i:s', time() - 600))
                    );
                    foreach ($expiredReservations as $expiredRes) {
                        $reservationId = (string)$expiredRes['reservation_id'];
                        $owner = (string)$expiredRes['owner_path'];
                        $resBytes = (int)$expiredRes['reserved_bytes'];
                        $attachmentId = (string)($expiredRes['attachment_id'] ?? '');

                        // Atomic conditional transition from active -> expired
                        $affected = $connection->update(
                            $resTable,
                            ['state' => 'expired', 'updated_at' => gmdate('Y-m-d H:i:s')],
                            ['reservation_id = ?' => $reservationId, 'state = ?' => 'active']
                        );

                        if ($affected > 0) {
                            // Release owner reserved quota
                            $connection->update($table, [
                                'reserved_bytes' => new \Zend_Db_Expr('GREATEST(0, CAST(reserved_bytes AS SIGNED) - ' . $resBytes . ')'),
                                'updated_at' => gmdate('Y-m-d H:i:s')
                            ], ['scope_type = ?' => 'owner', 'scope_key = ?' => $owner]);

                            // Release global reserved quota
                            $connection->update($table, [
                                'reserved_bytes' => new \Zend_Db_Expr('GREATEST(0, CAST(reserved_bytes AS SIGNED) - ' . $resBytes . ')'),
                                'updated_at' => gmdate('Y-m-d H:i:s')
                            ], ['scope_type = ?' => 'global', 'scope_key = ?' => 'module']);

                            if ($attachmentId !== '' && $connection->isTableExists($attTable)) {
                                $connection->update($attTable, [
                                    'state' => 'expired',
                                    'updated_at' => gmdate('Y-m-d H:i:s')
                                ], ['attachment_id = ?' => $attachmentId, 'state IN (?)' => ['issued', 'staged']]);
                            }
                            $corrected++;
                        }
                    }
                }

                // Reconcile finalizing attachments whose lease has expired (> 60s)
                if ($connection->isTableExists($attTable)) {
                    $staleFinalizing = $connection->fetchAll(
                        $connection->select()->from($attTable)
                            ->where('state = ?', 'finalizing')
                            ->where('updated_at < ?', gmdate('Y-m-d H:i:s', time() - 60))
                    );
                    foreach ($staleFinalizing as $staleAtt) {
                        $attId = (string)$staleAtt['attachment_id'];
                        $finalPath = (string)($staleAtt['final_path'] ?? '');
                        $stagedPath = (string)($staleAtt['staged_path'] ?? '');
                        
                        $finalExists = $finalPath !== '' && $directory->isFile($finalPath);
                        $stagedExists = $stagedPath !== '' && $directory->isFile($stagedPath);

                        if ($finalExists) {
                            $connection->update($attTable, [
                                'state' => 'committed',
                                'updated_at' => gmdate('Y-m-d H:i:s')
                            ], ['attachment_id = ?' => $attId, 'state = ?' => 'finalizing']);
                            $corrected++;
                        } elseif ($stagedExists) {
                            $connection->update($attTable, [
                                'state' => 'staged',
                                'updated_at' => gmdate('Y-m-d H:i:s')
                            ], ['attachment_id = ?' => $attId, 'state = ?' => 'finalizing']);
                            $corrected++;
                        } else {
                            $connection->update($attTable, [
                                'state' => 'failed',
                                'updated_at' => gmdate('Y-m-d H:i:s')
                            ], ['attachment_id = ?' => $attId, 'state = ?' => 'finalizing']);
                            $corrected++;
                        }
                    }
                }

                $connection->commit();
            } catch (\Throwable $exception) {
                $connection->rollBack();
                throw $exception;
            }

            return [
                'reconciled' => true,
                'owners' => count($ownerUsage),
                'global_bytes' => $globalUsage,
                'corrected' => $corrected,
            ];
        } finally {
            $this->lockManager->unlock(self::WRITE_LOCK);
        }
    }

    private function scanOwnerBytes(WriteInterface $directory, string $owner): int
    {
        $path = self::ATTACHMENT_PATH . '/' . $owner;
        if (!$directory->isExist($path)) {
            return 0;
        }
        $bytes = 0;
        foreach ($directory->search('*/*', $path) as $relativePath) {
            if (!preg_match('/\/\d+\/[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $relativePath)) {
                continue;
            }
            $stat = $directory->stat($relativePath);
            $bytes += max(0, (int)($stat['size'] ?? 0));
        }
        return $bytes;
    }

    private function scanAllBytes(WriteInterface $directory): int
    {
        $bytes = 0;
        foreach ($directory->search('*', self::ATTACHMENT_PATH) as $relativePath) {
            if (!preg_match(self::FILE_PATTERN, $relativePath)) {
                continue;
            }
            $stat = $directory->stat($relativePath);
            $bytes += max(0, (int)($stat['size'] ?? 0));
        }
        return $bytes;
    }
}
