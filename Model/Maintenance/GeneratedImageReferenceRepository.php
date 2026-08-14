<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Magento\Framework\App\ResourceConnection;

/** Indexed ownership records for generated images persisted in chat messages. */
class GeneratedImageReferenceRepository
{
    private const REFERENCE_TABLE = 'afd_ai_generated_image_reference';

    public function __construct(private readonly ResourceConnection $resource)
    {
    }

    public function replaceForMessage(int $messageId, string $role, string $content): void
    {
        if ($messageId < 1) {
            return;
        }

        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName(self::REFERENCE_TABLE);
        $connection->delete($table, ['message_id = ?' => $messageId]);

        if ($role !== 'assistant') {
            return;
        }

        $filenames = $this->generatedImageFilenames($content);
        if ($filenames === []) {
            return;
        }

        $now = gmdate('Y-m-d H:i:s');
        foreach ($filenames as $filename) {
            $connection->insert(
                $table,
                [
                    'message_id' => $messageId,
                    'filename' => $filename,
                    'created_at' => $now,
                ]
            );
        }
    }

    public function isReferenced(string $filename): bool
    {
        if (!preg_match('/^[A-Za-z0-9._-]{1,180}$/', $filename)) {
            return true;
        }

        $connection = $this->resource->getConnection();
        $select = $connection->select()
            ->from($this->resource->getTableName(self::REFERENCE_TABLE), ['message_id'])
            ->where('filename = ?', $filename)
            ->limit(1);

        return $connection->fetchOne($select) !== false;
    }

    /** @return string[] */
    private function generatedImageFilenames(string $content): array
    {
        try {
            $payload = json_decode($content, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }

        if (!is_array($payload) || !is_array($payload['parts'] ?? null)) {
            return [];
        }

        $filenames = [];
        foreach ($payload['parts'] as $part) {
            if (!is_array($part) || ($part['type'] ?? '') !== 'image') {
                continue;
            }
            $url = (string)($part['url'] ?? '');
            if (preg_match('~/media/afd-ai/generated/([A-Za-z0-9._-]{1,180})(?:[?#]|$)~', $url, $matches) !== 1) {
                continue;
            }
            $filenames[$matches[1]] = true;
        }

        return array_keys($filenames);
    }
}
