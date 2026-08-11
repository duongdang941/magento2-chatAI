<?php
declare(strict_types=1);

namespace Afd\AI\Ui\DataProvider;

use Afd\AI\Model\ResourceModel\SupportCase\CollectionFactory;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Ui\DataProvider\AbstractDataProvider;

class SupportCaseDataProvider extends AbstractDataProvider
{
    public function __construct(
        string $name,
        string $primaryFieldName,
        string $requestFieldName,
        CollectionFactory $collectionFactory,
        private readonly SupportInboxService $inboxService,
        array $meta = [],
        array $data = []
    ) {
        $this->collection = $collectionFactory->create();
        $this->collection->getSelect()
            ->reset(\Magento\Framework\DB\Select::COLUMNS)
            ->columns([
                'entity_id' => new \Zend_Db_Expr('MAX(main_table.entity_id)'),
                'contact_email_hash' => 'main_table.contact_email_hash',
                'contact_email' => new \Zend_Db_Expr('MAX(main_table.contact_email)'),
                'ticket_count' => new \Zend_Db_Expr('COUNT(*)'),
                'open_ticket_count' => new \Zend_Db_Expr("SUM(CASE WHEN main_table.status IN ('open','in_progress','waiting_customer') THEN 1 ELSE 0 END)"),
                'unread_count' => new \Zend_Db_Expr('SUM(main_table.admin_unread_count)'),
                'updated_at' => new \Zend_Db_Expr('MAX(main_table.updated_at)'),
            ])
            ->where('main_table.contact_email_hash IS NOT NULL')
            ->where('main_table.contact_email_hash != ?', '')
            ->group('main_table.contact_email_hash')
            ->order('unread_count DESC')
            ->order('updated_at DESC');
        parent::__construct($name, $primaryFieldName, $requestFieldName, $meta, $data);
    }

    public function getData(): array
    {
        $items = [];
        foreach ($this->collection->getItems() as $item) {
            $row = $item->getData();
            $row['contact_email'] = $this->inboxService->decryptEmail((string)($row['contact_email'] ?? ''));
            $items[] = $row;
        }
        return ['totalRecords' => $this->collection->getSize(), 'items' => $items];
    }
}
