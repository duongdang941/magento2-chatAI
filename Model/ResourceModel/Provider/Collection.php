<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel\Provider;

use Magento\Framework\Model\ResourceModel\Db\Collection\AbstractCollection;
use Afd\AI\Model\Provider as Model;
use Afd\AI\Model\ResourceModel\Provider as ResourceModel;

class Collection extends AbstractCollection
{
    protected function _construct(): void
    {
        $this->_init(Model::class, ResourceModel::class);
    }
}
