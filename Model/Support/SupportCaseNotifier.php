<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Magento\Framework\App\Area;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Mail\Template\TransportBuilder;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;
use Psr\Log\LoggerInterface;

class SupportCaseNotifier
{
    public function __construct(
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly ResourceConnection $resource,
        private readonly StoreManagerInterface $storeManager,
        private readonly TransportBuilder $transportBuilder,
        private readonly EncryptorInterface $encryptor,
        private readonly LoggerInterface $logger
    ) {
    }

    public function notifyCustomerStatus(array $case): void
    {
        $encryptedEmail = (string)($case['contact_email'] ?? '');
        if ($encryptedEmail === '') {
            return;
        }
        try {
            $storeId = $this->storeIdForCase($case);
            $email = strtolower(trim($this->encryptor->decrypt($encryptedEmail)));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                return;
            }
            $transport = $this->transportBuilder
                ->setTemplateIdentifier('afd_ai_support_case_status')
                ->setTemplateOptions(['area' => Area::AREA_FRONTEND, 'store' => $storeId])
                ->setTemplateVars(['case' => $case])
                ->setFromByScope('general', $storeId)
                ->addTo($email)
                ->getTransport();
            $transport->sendMessage();
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI support status email could not be sent.', ['exception' => $exception]);
        }
    }

    public function notifyCustomerReply(array $case, string $reply): void
    {
        $encryptedEmail = (string)($case['contact_email'] ?? '');
        if ($encryptedEmail === '') {
            return;
        }
        try {
            $storeId = $this->storeIdForCase($case);
            $email = strtolower(trim($this->encryptor->decrypt($encryptedEmail)));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                return;
            }
            $transport = $this->transportBuilder
                ->setTemplateIdentifier('afd_ai_support_case_reply')
                ->setTemplateOptions(['area' => Area::AREA_FRONTEND, 'store' => $storeId])
                ->setTemplateVars([
                    'case' => $case,
                    'reply' => mb_substr(trim($reply), 0, 4000),
                ])
                ->setFromByScope('general', $storeId)
                ->addTo($email)
                ->getTransport();
            $transport->sendMessage();
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI support reply email could not be sent.', ['exception' => $exception]);
        }
    }

    /** Notification failures never roll back a safely persisted support case. */
    public function notify(array $case): void
    {
        $storeId = $this->storeIdForCase($case);
        $recipient = trim((string)$this->scopeConfig->getValue(
            'afd_ai/support/recipient_email',
            ScopeInterface::SCOPE_STORE,
            $storeId
        ));
        if ($recipient === '') {
            return;
        }

        try {
            $transport = $this->transportBuilder
                ->setTemplateIdentifier('afd_ai_support_case_created')
                ->setTemplateOptions(['area' => Area::AREA_FRONTEND, 'store' => $storeId])
                ->setTemplateVars(['case' => $case])
                ->setFromByScope('general', $storeId)
                ->addTo($recipient)
                ->getTransport();
            $transport->sendMessage();
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI support-case email could not be sent.', ['exception' => $exception]);
        }
    }

    /** Resolve the stored thread's scope for asynchronous admin notifications. */
    private function storeIdForCase(array $case): int
    {
        $storeId = max(0, (int)($case['store_id'] ?? 0));
        if ($storeId > 0) {
            return $storeId;
        }

        $conversationId = max(0, (int)($case['conversation_id'] ?? 0));
        if ($conversationId > 0) {
            try {
                $storeId = (int)$this->resource->getConnection()->fetchOne(
                    $this->resource->getConnection()->select()
                        ->from($this->resource->getTableName('afd_ai_conversation'), ['store_id'])
                        ->where('conversation_id = ?', $conversationId)
                        ->limit(1)
                );
            } catch (\Throwable) {
                $storeId = 0;
            }
        }

        return $storeId > 0 ? $storeId : (int)$this->storeManager->getDefaultStoreView()->getId();
    }
}
