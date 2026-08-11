<?php
declare(strict_types=1);

namespace Afd\AI\Model\Support;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Encryption\EncryptorInterface;

class SupportInboxService
{
    private const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting_customer'];

    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly EncryptorInterface $encryptor
    ) {
    }

    public function emailHash(string $email): string
    {
        $email = strtolower(trim($email));
        return filter_var($email, FILTER_VALIDATE_EMAIL) ? hash('sha256', $email) : '';
    }

    public function decryptEmail(string $encrypted): string
    {
        try {
            $email = strtolower(trim($this->encryptor->decrypt($encrypted)));
            return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
        } catch (\Throwable) {
            return '';
        }
    }

    /** @return array<int, array<string, mixed>> */
    public function getTicketsForCase(array $case): array
    {
        $hash = (string)($case['contact_email_hash'] ?? '');
        if ($hash === '') {
            $hash = $this->emailHash($this->decryptEmail((string)($case['contact_email'] ?? '')));
        }
        if ($hash === '') {
            return [$case];
        }

        $storeId = (int)($case['store_id'] ?? 0);
        $websiteId = (int)($case['website_id'] ?? 0);
        if ($storeId < 1 || $websiteId < 1) {
            return [$case];
        }

        $connection = $this->resource->getConnection();
        return $connection->fetchAll(
            $connection->select()
                ->from(['support_case' => $this->resource->getTableName('afd_ai_support_case')])
                ->where('support_case.contact_email_hash = ?', $hash)
                ->where('support_case.store_id = ?', $storeId)
                ->where('support_case.website_id = ?', $websiteId)
                ->order('support_case.admin_unread_count DESC')
                ->order('support_case.updated_at DESC')
        );
    }

    public function markAdminRead(int $caseId): bool
    {
        return $caseId > 0 && $this->resource->getConnection()->update(
            $this->resource->getTableName('afd_ai_support_case'),
            ['admin_unread_count' => 0],
            ['entity_id = ?' => $caseId]
        ) >= 0;
    }

    public function recordCustomerMessage(int $conversationId): void
    {
        if ($conversationId < 1) {
            return;
        }
        $connection = $this->resource->getConnection();
        $caseTable = $this->resource->getTableName('afd_ai_support_case');
        $now = gmdate('Y-m-d H:i:s');
        $connection->update($caseTable, [
            'admin_unread_count' => new \Zend_Db_Expr('admin_unread_count + 1'),
            'customer_unread_count' => 0,
            'last_customer_message_at' => $now,
            'status' => 'open',
            'updated_at' => $now,
        ], [
            'conversation_id = ?' => $conversationId,
            'status IN (?)' => self::ACTIVE_STATUSES,
        ]);
    }
}
