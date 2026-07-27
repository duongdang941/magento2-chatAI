<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Quality;

use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\View\Result\Page;
use Magento\Framework\View\Result\PageFactory;

class Index extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::quality';

    public function __construct(Context $context, private readonly PageFactory $pageFactory)
    {
        parent::__construct($context);
    }

    public function execute(): Page
    {
        $page = $this->pageFactory->create();
        $page->setActiveMenu('Afd_AI::quality');
        $page->getConfig()->getTitle()->prepend(__('Store Assistant Quality'));
        return $page;
    }
}
