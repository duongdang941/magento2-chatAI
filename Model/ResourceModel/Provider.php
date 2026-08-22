<?php
declare(strict_types=1);

namespace Afd\AI\Model\ResourceModel;

use Magento\Framework\Model\ResourceModel\Db\AbstractDb;

class Provider extends AbstractDb
{
    public const TABLE_NAME = "afd_ai_provider";

    protected function _construct(): void
    {
        $this->_init(self::TABLE_NAME, "provider_id");
    }
}
