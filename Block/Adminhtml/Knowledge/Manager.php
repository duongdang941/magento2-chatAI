<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\Knowledge;

use Magento\Backend\Block\Template;
use Magento\Backend\Block\Template\Context;
use Magento\Customer\Model\ResourceModel\Group\CollectionFactory as CustomerGroupCollectionFactory;
use Magento\Framework\App\ResourceConnection;
use Magento\Store\Model\StoreManagerInterface;

class Manager extends Template
{
    public function __construct(
        Context $context,
        private readonly ResourceConnection $resource,
        private readonly StoreManagerInterface $storeManager,
        private readonly CustomerGroupCollectionFactory $customerGroupCollectionFactory,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    public function getDocument(): array
    {
        $id = max(0, (int)$this->getRequest()->getParam('id'));
        if ($id < 1) return [];
        return (array)$this->resource->getConnection()->fetchRow(
            $this->resource->getConnection()->select()->from($this->resource->getTableName('afd_ai_knowledge_document'))->where('entity_id = ?', $id)
        );
    }

    public function getDocuments(): array
    {
        return $this->resource->getConnection()->fetchAll(
            $this->resource->getConnection()->select()->from($this->resource->getTableName('afd_ai_knowledge_document'))->order('updated_at DESC')->limit(100)
        );
    }

    public function getStores(): array
    {
        $stores = [];
        foreach ($this->storeManager->getStores(true) as $store) {
            if ($store->isActive()) $stores[] = ['id' => (int)$store->getId(), 'name' => (string)$store->getName(), 'code' => (string)$store->getCode()];
        }
        return $stores;
    }

    /** @return array<int, array{id:int,name:string}> */
    public function getCustomerGroups(): array
    {
        $groups = [];
        foreach ($this->customerGroupCollectionFactory->create()->setOrder('customer_group_code', 'ASC') as $group) {
            $groups[] = [
                'id' => (int)$group->getId(),
                'name' => (string)$group->getCode(),
            ];
        }
        return $groups;
    }
}
