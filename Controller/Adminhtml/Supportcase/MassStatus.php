<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\ResourceModel\SupportCase\CollectionFactory;
use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\Support\SupportCaseNotifier;
use Afd\AI\Model\Gateway\SupportMessagePublisher;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\Controller\Result\Redirect;
use Magento\Ui\Component\MassAction\Filter;

class MassStatus extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';
    private const STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];

    public function __construct(
        Context $context,
        private readonly Filter $filter,
        private readonly CollectionFactory $collectionFactory,
        private readonly SupportCaseResource $supportCaseResource,
        private readonly SupportCaseNotifier $notifier,
        private readonly SupportMessagePublisher $publisher
    ) {
        parent::__construct($context);
    }

    public function execute(): Redirect
    {
        $status = strtolower((string)$this->getRequest()->getParam('status'));
        if (!in_array($status, self::STATUSES, true)) {
            $this->messageManager->addErrorMessage(__('Choose a valid case status.'));
            return $this->resultRedirectFactory->create()->setPath('*/*/index');
        }

        $collection = $this->filter->getCollection($this->collectionFactory->create());
        $count = 0;
        foreach ($collection as $case) {
            $case->setData('status', $status);
            if ($status === 'in_progress') {
                $case->setData('assigned_admin_id', (int)$this->_auth->getUser()->getId());
            }
            $case->setData('resolved_at', in_array($status, ['resolved', 'closed'], true) ? gmdate('Y-m-d H:i:s') : null);
            if (in_array($status, ['resolved', 'closed'], true)) {
                $case->setData('takeover_state', 'inactive');
                $case->setData('takeover_expires_at', null);
                $case->setData('takeover_ended_at', gmdate('Y-m-d H:i:s'));
            }
            $this->supportCaseResource->save($case);
            if (in_array($status, ['resolved', 'closed'], true)) {
                $this->publisher->publishMode($case->getData(), false);
            }
            $this->notifier->notifyCustomerStatus($case->getData());
            $count++;
        }
        $this->messageManager->addSuccessMessage(__('%1 support case(s) updated.', $count));
        return $this->resultRedirectFactory->create()->setPath('*/*/index');
    }
}
