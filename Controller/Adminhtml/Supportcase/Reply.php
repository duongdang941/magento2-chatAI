<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Support\SupportReplyService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\Redirect;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\ResultInterface;

class Reply extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';

    public function __construct(
        Context $context,
        private readonly SupportReplyService $replyService
    ) {
        parent::__construct($context);
    }

    public function execute(): ResultInterface
    {
        $caseId = (int)$this->getRequest()->getParam('entity_id');
        try {
            $admin = $this->_auth->getUser();
            $result = $this->replyService->reply(
                $caseId,
                (int)$admin->getId(),
                trim((string)$admin->getFirstName() . ' ' . (string)$admin->getLastName()),
                (string)$this->getRequest()->getParam('reply')
            );
            $this->messageManager->addSuccessMessage($result['duplicate']
                ? __('This reply was already sent.')
                : __('The reply was sent and saved in the customer conversation.'));
            if ($this->getRequest()->isAjax()) {
                /** @var Json $json */ $json = $this->resultFactory->create(ResultFactory::TYPE_JSON);
                return $json->setData(['status' => 'success', 'message_id' => $result['message_id'], 'duplicate' => $result['duplicate']]);
            }
        } catch (\Throwable $exception) {
            if ($this->getRequest()->isAjax()) {
                /** @var Json $json */ $json = $this->resultFactory->create(ResultFactory::TYPE_JSON);
                return $json->setHttpResponseCode(400)->setData(['status' => 'error', 'message' => $exception->getMessage()]);
            }
            $this->messageManager->addErrorMessage($exception->getMessage());
        }

        return $this->resultRedirectFactory->create()->setPath('*/*/view', ['entity_id' => $caseId]);
    }
}
