<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\Provider;

use Magento\Backend\Block\Template;

class Modal extends Template
{
    public function getSaveUrl(): string
    {
        return $this->getUrl('afd_ai/provider/save');
    }

    public function getFetchUrl(): string
    {
        return $this->getUrl('afd_ai/provider/get');
    }

    public function getDeleteUrl(): string
    {
        return $this->getUrl('afd_ai/provider/delete');
    }

    public function getHealthUrl(): string
    {
        return $this->getUrl('afd_ai/provider/health');
    }

    public function getSyncUrl(): string
    {
        return $this->getUrl('afd_ai/provider/sync');
    }
}
