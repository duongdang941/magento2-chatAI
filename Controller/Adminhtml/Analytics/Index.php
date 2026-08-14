<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Analytics;

use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\View\Result\Page;
use Magento\Framework\View\Result\PageFactory;

class Index extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::analytics';

    public function __construct(Context $context, private readonly PageFactory $pageFactory)
    {
        parent::__construct($context);
    }

    public function execute(): Page
    {
        $page = $this->pageFactory->create();
        $page->setActiveMenu('Afd_AI::analytics');
        $page->getConfig()->getTitle()->prepend(__('Store Assistant Analytics'));
        return $page;
    }
}
