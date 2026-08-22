<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Knowledge;

use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\View\Result\Page;
use Magento\Framework\View\Result\PageFactory;

class Index extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::knowledge';

    public function __construct(Context $context, private readonly PageFactory $pageFactory)
    {
        parent::__construct($context);
    }

    public function execute(): Page
    {
        $page = $this->pageFactory->create();
        $page->setActiveMenu('Afd_AI::knowledge');
        $page->getConfig()->getTitle()->prepend(__('Store Assistant Knowledge Base'));
        return $page;
    }
}
