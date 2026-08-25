<?php
declare(strict_types=1);

namespace Afd\AI\Model\Maintenance;

use Afd\AI\Model\Config\Config as AiConfig;
use Magento\Framework\App\ResourceConnection;

/**
 * Bounds telemetry growth by aging out attribution events and guardrail
 * decisions. Deletes run in oldest-first batches so one cron pass can never
 * lock the tables for an unbounded time, mirroring the conversation retention
 * batches in Afd\AI\Model\Privacy\ConversationDataEraser.
 */
class TelemetryRetentionCleaner
{
    private const BATCH_SIZE = 500;
    private const MAX_BATCHES_PER_TABLE = 40;

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly AiConfig $config
    ) {
    }

    /** @return array{analytics_events:int,guardrail_audits:int} */
    public function execute(?int $now = null): array
    {
        $now ??= time();
        return [
            'analytics_events' => $this->deleteAgedRows(
                'afd_ai_analytics_event',
                'event_id',
                $this->config->getAnalyticsRetentionDays(),
                $now
            ),
            'guardrail_audits' => $this->deleteAgedRows(
                'afd_ai_guardrail_audit',
                'audit_id',
                $this->config->getGuardrailAuditRetentionDays(),
                $now
            ),
        ];
    }

    private function deleteAgedRows(string $table, string $identifier, int $retentionDays, int $now): int
    {
        $connection = $this->resource->getConnection();
        $tableName = $this->resource->getTableName($table);
        if (!$connection->isTableExists($tableName)) {
            return 0;
        }

        $cutoff = gmdate('Y-m-d H:i:s', $now - (max(1, $retentionDays) * 86400));
        $deleted = 0;
        for ($batch = 0; $batch < self::MAX_BATCHES_PER_TABLE; $batch++) {
            $ids = $connection->fetchCol(
                $connection->select()
                    ->from($tableName, [$identifier])
                    ->where('created_at < ?', $cutoff)
                    ->order($identifier . ' ASC')
                    ->limit(self::BATCH_SIZE)
            );
            if (!is_array($ids) || $ids === []) {
                break;
            }

            $deleted += $connection->delete(
                $tableName,
                [$identifier . ' IN (?)' => $ids]
            );
            if (count($ids) < self::BATCH_SIZE) {
                break;
            }
        }

        return $deleted;
    }
}
