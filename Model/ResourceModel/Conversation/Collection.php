<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel\Conversation;

use Magento\Framework\Model\ResourceModel\Db\Collection\AbstractCollection;

class Collection extends AbstractCollection
{
    protected function _construct()
    {
        $this->_init(
            \Afd\AI\Model\Conversation::class,
            \Afd\AI\Model\ResourceModel\Conversation::class
        );
    }
}
