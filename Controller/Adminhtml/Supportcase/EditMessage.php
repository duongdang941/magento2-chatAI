<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Support\SupportMessageMutationService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class EditMessage extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';

    public function __construct(Context $context, private readonly SupportMessageMutationService $mutationService)
    {
        parent::__construct($context);
    }

    public function execute(): Json
    {
        /** @var Json $result */ $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        try {
            return $result->setData($this->mutationService->mutateForAdmin(
                (int)$this->getRequest()->getParam('entity_id'),
                (int)$this->getRequest()->getParam('message_id'),
                'edit',
                (string)$this->getRequest()->getParam('content'),
                (int)$this->_auth->getUser()->getId()
            ));
        } catch (\Throwable $exception) {
            return $result->setHttpResponseCode(400)->setData(['status' => 'error', 'message' => $exception->getMessage()]);
        }
    }
}
