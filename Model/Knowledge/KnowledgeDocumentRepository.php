<?php
declare(strict_types=1);

namespace Afd\AI\Model\Knowledge;

use Magento\Framework\App\ResourceConnection;

/** Persistence for admin-managed knowledge base documents. */
class KnowledgeDocumentRepository
{
    private const DOCUMENT_TABLE = 'afd_ai_knowledge_document';

    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    /** @return array<string, mixed>|null */
    public function getById(int $entityId): ?array
    {
        $connection = $this->resource->getConnection();
        $row = $connection->fetchRow(
            $connection->select()
                ->from($this->resource->getTableName(self::DOCUMENT_TABLE))
                ->where('entity_id = ?', $entityId)
        );

        return is_array($row) && $row !== [] ? $row : null;
    }

    /** @param array<string, mixed> $data */
    public function save(int $entityId, array $data): void
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::DOCUMENT_TABLE);

        if ($entityId > 0) {
            $connection->update($table, $data, ['entity_id = ?' => $entityId]);
            return;
        }

        $connection->insert($table, $data);
    }

    public function delete(int $entityId): void
    {
        $this->resource->getConnection()->delete(
            $this->resource->getTableName(self::DOCUMENT_TABLE),
            ['entity_id = ?' => $entityId]
        );
    }
}