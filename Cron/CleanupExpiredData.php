<?php
declare(strict_types=1);

namespace Afd\AI\Cron;

use Afd\AI\Model\Maintenance\ExpiredDataCleaner;
use Afd\AI\Model\Privacy\RetentionCleaner;
use Psr\Log\LoggerInterface;

/** Daily bounded cleanup for expired AI runtime data. */
class CleanupExpiredData
{
    public function __construct(
        private readonly ExpiredDataCleaner $cleaner,
        private readonly RetentionCleaner $retentionCleaner,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute(): void
    {
        try {
            $result = $this->cleaner->execute();
            $result += $this->retentionCleaner->execute();
            if (array_sum($result) > 0) {
                $this->logger->info('Afd AI expired data cleanup completed.', $result);
            }
        } catch (\Throwable $exception) {
            $this->logger->error('Afd AI expired data cleanup failed.', ['exception' => $exception]);
        }
    }
}
