<?php
declare(strict_types=1);

namespace Afd\AI\Observer;

use Afd\AI\Model\Analytics\AnalyticsEventService;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Quote\Model\Quote;
use Magento\Sales\Api\Data\OrderInterface;
use Psr\Log\LoggerInterface;

/** Records only lifecycle events that can be tied to a prior AI cart action. */
class RecordCommerceAnalytics implements ObserverInterface
{
    public function __construct(
        private readonly AnalyticsEventService $analytics,
        private readonly LoggerInterface $logger
    ) {
    }

    public function execute(Observer $observer): void
    {
        try {
            $event = $observer->getEvent();
            $quote = $event->getQuote();
            if ($quote instanceof Quote) {
                $this->analytics->recordCheckoutStarted($quote);
                return;
            }

            $creditmemo = $event->getCreditmemo();
            if (is_object($creditmemo) && $creditmemo->getOrder() instanceof OrderInterface) {
                $this->analytics->recordOrderRefunded(
                    $creditmemo->getOrder(),
                    max(0, (int)$creditmemo->getEntityId()),
                    (float)$creditmemo->getGrandTotal()
                );
                return;
            }

            $order = $event->getOrder();
            if (!$order instanceof OrderInterface) {
                return;
            }
            $this->analytics->recordOrderPlaced($order);
        } catch (\Throwable $error) {
            // Order placement/refund/cancel must never depend on telemetry.
            $this->logger->warning('Afd AI could not record commerce attribution.', ['exception' => $error]);
        }
    }
}
