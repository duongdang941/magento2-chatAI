<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Model\Analytics\AnalyticsEventService;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Sales\Api\Data\OrderInterface;
use Psr\Log\LoggerInterface;

/** Keeps the cancellation event distinct from order placement. */
class RecordOrderCancellationAnalytics implements ObserverInterface
{
    public function __construct(
        private readonly AnalyticsEventService $analytics,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute(Observer $observer): void
    {
        try {
            $order = $observer->getEvent()->getOrder();
            if ($order instanceof OrderInterface) {
                $this->analytics->recordOrderCancelled($order);
            }
        } catch (\Throwable $error) {
            $this->logger->warning('Afd AI could not record cancellation attribution.', ['exception' => $error]);
        }
    }
}
