<?php
declare(strict_types=1);

namespace Afd\AI\Model\Attachment;

use Magento\Framework\App\ResourceConnection;

/**
 * Manages atomic DB state transitions for chat attachments.
 */
class AttachmentRepository
{
    private const TABLE_ATTACHMENT = 'afd_ai_attachment';
    private const TABLE_RESERVATION = 'afd_ai_attachment_reservation';

    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    public function recordIssued(
        string $attachmentId,
        string $ownerType,
        string $ownerKey,
        int $bytes,
        string $mime,
        int $expiresAt,
        ?string $reservationId = null,
        ?string $nonceHash = null,
        ?int $conversationId = null
    ): void {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        $connection->insert($table, [
            'attachment_id' => $attachmentId,
            'owner_type' => $ownerType,
            'owner_key' => $ownerKey,
            'conversation_id' => $conversationId ?: null,
            'state' => 'issued',
            'mime_type' => $mime,
            'bytes' => $bytes,
            'reservation_id' => $reservationId,
            'nonce_hash' => $nonceHash,
            'expires_at' => gmdate('Y-m-d H:i:s', $expiresAt),
            'created_at' => gmdate('Y-m-d H:i:s'),
            'updated_at' => gmdate('Y-m-d H:i:s')
        ]);
    }

    /**
     * Atomically consumes an issued ticket before any staged file is created.
     * The nonce is retained only as a hash, so a replay cannot claim it twice.
     */
    public function claimForUpload(
        string $attachmentId,
        string $ownerKey,
        string $nonce,
        int $now = 0
    ): bool {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);
        $now = $now > 0 ? $now : time();

        $affected = $connection->update($table, [
            'state' => 'uploading',
            'updated_at' => gmdate('Y-m-d H:i:s', $now)
        ], [
            'attachment_id = ?' => $attachmentId,
            'owner_key = ?' => $ownerKey,
            'nonce_hash = ?' => hash('sha256', $nonce),
            'state = ?' => 'issued',
            'expires_at >= ?' => gmdate('Y-m-d H:i:s', $now)
        ]);

        return $affected === 1;
    }

    public function releaseUploadClaim(string $attachmentId): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);
        $connection->update($table, [
            'state' => 'issued',
            'updated_at' => gmdate('Y-m-d H:i:s')
        ], [
            'attachment_id = ?' => $attachmentId,
            'state = ?' => 'uploading'
        ]);
    }

    public function recordStaged(
        string $attachmentId,
        string $stagedPath,
        int $actualBytes,
        string $sha256
    ): bool {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        return $connection->update($table, [
            'state' => 'staged',
            'staged_path' => $stagedPath,
            'bytes' => $actualBytes,
            'sha256' => $sha256,
            'updated_at' => gmdate('Y-m-d H:i:s')
        ], [
            'attachment_id = ?' => $attachmentId,
            'state = ?' => 'uploading'
        ]) === 1;
    }

    public function tryMarkFinalizing(string $attachmentId, int $leaseSeconds = 30): bool
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);
        $staleThreshold = gmdate('Y-m-d H:i:s', time() - $leaseSeconds);

        // Allow transition from issued/staged or expired finalizing lease (> 30s)
        $affected = $connection->update(
            $table,
            [
                'state' => 'finalizing',
                'updated_at' => gmdate('Y-m-d H:i:s')
            ],
            [
                'attachment_id = ?' => $attachmentId,
                'state IN (?) OR (state = ? AND updated_at < ?)' => [
                    ['issued', 'staged'],
                    'finalizing',
                    $staleThreshold
                ]
            ]
        );

        return $affected > 0;
    }

    public function recordCommitted(
        string $attachmentId,
        string $finalPath,
        ?int $conversationId = null
    ): void {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        $data = [
            'state' => 'committed',
            'final_path' => $finalPath,
            'updated_at' => gmdate('Y-m-d H:i:s')
        ];
        if ($conversationId !== null && $conversationId > 0) {
            $data['conversation_id'] = $conversationId;
        }

        $connection->update($table, $data, ['attachment_id = ?' => $attachmentId]);
    }

    public function getAttachment(string $attachmentId): ?array
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        $row = $connection->fetchRow(
            $connection->select()->from($table)->where('attachment_id = ?', $attachmentId)
        );

        return is_array($row) && !empty($row) ? $row : null;
    }

    public function recordReservation(
        string $reservationId,
        string $attachmentId,
        string $ownerPath,
        int $bytes,
        int $expiresAt
    ): void {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_RESERVATION);

        $connection->insert($table, [
            'reservation_id' => $reservationId,
            'attachment_id' => $attachmentId,
            'owner_path' => $ownerPath,
            'reserved_bytes' => $bytes,
            'state' => 'active',
            'expires_at' => gmdate('Y-m-d H:i:s', $expiresAt),
            'created_at' => gmdate('Y-m-d H:i:s'),
            'updated_at' => gmdate('Y-m-d H:i:s')
        ]);
    }

    public function getReservation(string $reservationId): ?array
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_RESERVATION);

        $row = $connection->fetchRow(
            $connection->select()->from($table)->where('reservation_id = ?', $reservationId)
        );

        return is_array($row) && !empty($row) ? $row : null;
    }

    public function releaseReservation(string $reservationId): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_RESERVATION);

        $connection->update($table, [
            'state' => 'released',
            'updated_at' => gmdate('Y-m-d H:i:s')
        ], ['reservation_id = ?' => $reservationId]);
    }

    /**
     * Atomically commits attachment, releases reservation, and commits quota in a single DB transaction.
     * Enforces strict state predicate, owner binding, reservation authority, and exact delta quota settlement.
     */
    public function commitFinalAttachmentAtomic(
        string $attachmentId,
        string $finalPath,
        string $ownerPath,
        int $fileSize,
        ?string $reservationId = null,
        ?int $conversationId = null,
        string $ownerKey = ''
    ): void {
        $connection = $this->resource->getConnection();
        $tableAtt = $this->resource->getTableName(self::TABLE_ATTACHMENT);
        $tableRes = $this->resource->getTableName(self::TABLE_RESERVATION);
        $tableQuota = $this->resource->getTableName('afd_ai_attachment_quota');

        $connection->beginTransaction();
        try {
            $now = gmdate('Y-m-d H:i:s');
            $releaseReserved = $fileSize;

            // 1. Validate & Lock Reservation if provided (Fail-Closed)
            if ($reservationId !== null && $reservationId !== '') {
                if (!$connection->isTableExists($tableRes)) {
                    throw new \Magento\Framework\Exception\LocalizedException(
                        __('Attachment reservation table is unavailable.')
                    );
                }

                $resSelect = $connection->select()->from($tableRes)
                    ->where('reservation_id = ?', $reservationId)
                    ->where('attachment_id = ?', $attachmentId)
                    ->where('owner_path = ?', $ownerPath)
                    ->where('state = ?', 'active')
                    ->where('expires_at >= ?', $now)
                    ->forUpdate(true);

                $resRow = $connection->fetchRow($resSelect);
                if (!$resRow) {
                    throw new \Magento\Framework\Exception\LocalizedException(
                        __('Valid active attachment reservation was not found or has expired.')
                    );
                }

                $releaseReserved = (int)($resRow['reserved_bytes'] ?? $fileSize);
                $affectedRes = $connection->update($tableRes, [
                    'state' => 'committed',
                    'updated_at' => $now
                ], [
                    'reservation_id = ?' => $reservationId,
                    'state = ?' => 'active'
                ]);
                if ($affectedRes === 0) {
                    throw new \Magento\Framework\Exception\LocalizedException(
                        __('Attachment reservation conflict or already processed.')
                    );
                }
            }

            // 2. Update attachment state from finalizing -> committed
            $attData = [
                'state' => 'committed',
                'final_path' => $finalPath,
                'bytes' => $fileSize,
                'updated_at' => $now
            ];
            if ($conversationId !== null && $conversationId > 0) {
                $attData['conversation_id'] = $conversationId;
            }

            $attWhere = ['attachment_id = ?' => $attachmentId, 'state = ?' => 'finalizing'];
            if ($ownerKey !== '') {
                $attWhere['owner_key = ?'] = $ownerKey;
            }

            $affectedAtt = $connection->update($tableAtt, $attData, $attWhere);
            if ($affectedAtt === 0) {
                // Check if already committed by concurrent idempotent complete
                $existing = $this->getAttachment($attachmentId);
                if ($existing && ($existing['state'] ?? '') === 'committed') {
                    $connection->commit();
                    return;
                }
                throw new \Magento\Framework\Exception\LocalizedException(
                    __('Attachment state conflict during finalization.')
                );
            }

            // 3. Update quota counters atomically with exact reservation delta
            if ($connection->isTableExists($tableQuota)) {
                $ownerRow = $connection->fetchRow(
                    $connection->select()->from($tableQuota)
                        ->where('scope_type = ?', 'owner')
                        ->where('scope_key = ?', $ownerPath)
                        ->forUpdate(true)
                );
                if ($ownerRow) {
                    $currentReserved = (int)$ownerRow['reserved_bytes'];
                    $currentUsed = (int)$ownerRow['used_bytes'];
                    $newReserved = max(0, $currentReserved - $releaseReserved);
                    $newUsed = $currentUsed + $fileSize;
                    $connection->update($tableQuota, [
                        'used_bytes' => $newUsed,
                        'reserved_bytes' => $newReserved,
                        'updated_at' => $now
                    ], ['scope_id = ?' => (int)$ownerRow['scope_id']]);
                }

                $globalRow = $connection->fetchRow(
                    $connection->select()->from($tableQuota)
                        ->where('scope_type = ?', 'global')
                        ->where('scope_key = ?', 'module')
                        ->forUpdate(true)
                );
                if ($globalRow) {
                    $currentReserved = (int)$globalRow['reserved_bytes'];
                    $currentUsed = (int)$globalRow['used_bytes'];
                    $newReserved = max(0, $currentReserved - $releaseReserved);
                    $newUsed = $currentUsed + $fileSize;
                    $connection->update($tableQuota, [
                        'used_bytes' => $newUsed,
                        'reserved_bytes' => $newReserved,
                        'updated_at' => $now
                    ], ['scope_id = ?' => (int)$globalRow['scope_id']]);
                }
            }

            $connection->commit();
        } catch (\Throwable $e) {
            $connection->rollBack();
            throw $e;
        }
    }
}
