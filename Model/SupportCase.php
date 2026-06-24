<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Magento\Framework\Model\AbstractModel;

class SupportCase extends AbstractModel
{
    protected function _construct(): void
    {
        $this->_init(\Afd\AI\Model\ResourceModel\SupportCase::class);
    }
}
