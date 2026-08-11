<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel;

use Magento\Framework\Model\ResourceModel\Db\AbstractDb;

class Message extends AbstractDb
{
    protected function _construct()
    {
        $this->_init('afd_ai_message', 'entity_id');
    }
}
