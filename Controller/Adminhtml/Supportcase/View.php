<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\SupportCaseFactory;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\Registry;
use Magento\Framework\View\Result\Page;
use Magento\Framework\View\Result\PageFactory;

class View extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';

    public function __construct(
        Context $context,
        private readonly PageFactory $pageFactory,
        private readonly SupportCaseFactory $supportCaseFactory,
        private readonly SupportCaseResource $supportCaseResource,
        private readonly Registry $registry
    ) {
        parent::__construct($context);
    }

    public function execute(): Page|\Magento\Backend\Model\View\Result\Redirect
    {
        $case = $this->supportCaseFactory->create();
        $this->supportCaseResource->load($case, (int)$this->getRequest()->getParam('entity_id'));
        if (!$case->getId()) {
            $this->messageManager->addErrorMessage(__('The support case no longer exists.'));
            return $this->resultRedirectFactory->create()->setPath('*/*/index');
        }
        $this->registry->register('afd_ai_support_case', $case);
        $page = $this->pageFactory->create();
        $page->setActiveMenu('Afd_AI::support_cases');
        $page->getConfig()->getTitle()->prepend(__('Support Inbox · %1', $case->getData('public_id')));
        return $page;
    }
}
