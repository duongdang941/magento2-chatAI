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

    public function recordStaged(
        string $attachmentId,
        string $stagedPath,
        int $actualBytes,
        string $sha256
    ): void {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        $connection->update($table, [
            'state' => 'staged',
            'staged_path' => $stagedPath,
            'bytes' => $actualBytes,
            'sha256' => $sha256,
            'updated_at' => gmdate('Y-m-d H:i:s')
        ], ['attachment_id = ?' => $attachmentId]);
    }

    public function tryMarkFinalizing(string $attachmentId): bool
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_ATTACHMENT);

        $affected = $connection->update(
            $table,
            [
                'state' => 'finalizing',
                'updated_at' => gmdate('Y-m-d H:i:s')
            ],
            [
                'attachment_id = ?' => $attachmentId,
                'state IN (?)' => ['issued', 'staged']
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

    public function releaseReservation(string $reservationId): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::TABLE_RESERVATION);

        $connection->update($table, [
            'state' => 'released',
            'updated_at' => gmdate('Y-m-d H:i:s')
        ], ['reservation_id = ?' => $reservationId]);
    }
}
