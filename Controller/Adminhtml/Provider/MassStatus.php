<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Ui\Component\MassAction\Filter;

class MassStatus extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::providers';

    public function __construct(
        Context $context,
        private readonly Filter $filter,
        private readonly CollectionFactory $collectionFactory,
        private readonly ProviderRepositoryInterface $providerRepository
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        try {
            $status = (int)$this->getRequest()->getParam('status', 1);
            $collection = $this->filter->getCollection($this->collectionFactory->create());
            $count = 0;
            foreach ($collection as $item) {
                $item->setIsActive($status);
                $this->providerRepository->save($item);
                $count++;
            }
            $this->messageManager->addSuccessMessage(__('A total of %1 provider(s) status updated.', $count));
        } catch (\Throwable $e) {
            $this->messageManager->addErrorMessage(__('Error updating providers: %1', $e->getMessage()));
        }

        /** @var \Magento\Backend\Model\View\Result\Redirect $resultRedirect */
        $resultRedirect = $this->resultFactory->create(ResultFactory::TYPE_REDIRECT);
        return $resultRedirect->setPath('afd_ai/provider/index');
    }
}
