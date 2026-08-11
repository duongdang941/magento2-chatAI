<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel\SupportCase;

use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\SupportCase;
use Magento\Framework\Model\ResourceModel\Db\Collection\AbstractCollection;

class Collection extends AbstractCollection
{
    protected function _construct(): void
    {
        $this->_init(SupportCase::class, SupportCaseResource::class);
    }
}
