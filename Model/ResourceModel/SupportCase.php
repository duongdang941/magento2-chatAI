<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel;

use Magento\Framework\Model\ResourceModel\Db\AbstractDb;

class SupportCase extends AbstractDb
{
    protected function _construct(): void
    {
        $this->_init('afd_ai_support_case', 'entity_id');
    }
}
