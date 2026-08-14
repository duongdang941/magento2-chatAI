<?php
declare(strict_types=1);

namespace Afd\AI\Setup\Patch\Data;

use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Setup\Patch\DataPatchInterface;

class BackfillSupportInbox implements DataPatchInterface
{
    public function __construct(
        private readonly ResourceConnection $resource,
        private readonly EncryptorInterface $encryptor
    ) {
    }

    public function apply(): self
    {
        $connection = $this->resource->getConnection();
        $table = $this->resource->getTableName('afd_ai_support_case');
        $rows = $connection->fetchAll(
            $connection->select()
                ->from($table, ['entity_id', 'contact_email', 'created_at'])
                ->where('contact_email_hash IS NULL OR contact_email_hash = ?', '')
        );

        foreach ($rows as $row) {
            try {
                $email = strtolower(trim($this->encryptor->decrypt((string)$row['contact_email'])));
            } catch (\Throwable) {
                continue;
            }
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                continue;
            }
            $connection->update($table, [
                'contact_email_hash' => hash('sha256', $email),
                'admin_unread_count' => 1,
                'last_customer_message_at' => $row['created_at'] ?: gmdate('Y-m-d H:i:s'),
            ], ['entity_id = ?' => (int)$row['entity_id']]);
        }

        return $this;
    }

    public static function getDependencies(): array
    {
        return [];
    }

    public function getAliases(): array
    {
        return [];
    }
}
