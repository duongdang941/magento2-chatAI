<?php
declare(strict_types=1);
namespace Afd\AI\Cron;

use Afd\AI\Model\Maintenance\AttachmentQuotaReconciler;
use Psr\Log\LoggerInterface;

/** Periodically repairs quota counters after crashes or manual file changes. */
class ReconcileAttachmentQuota
{
    public function __construct(
        private readonly AttachmentQuotaReconciler $reconciler,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute(): void
    {
        try {
            $result = $this->reconciler->execute();
            if ($result['reconciled'] && $result['corrected'] > 0) {
                $this->logger->info(
                    'Afd AI attachment quota reconciliation corrected counters.',
                    $result
                );
            }
        } catch (\Throwable $exception) {
            $this->logger->error(
                'Afd AI attachment quota reconciliation failed.',
                ['exception' => $exception]
            );
        }
    }
}
