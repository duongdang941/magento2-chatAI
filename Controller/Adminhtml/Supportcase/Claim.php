<?php
declare(strict_types=1);
namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Support\SupportTakeoverService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\Redirect;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\ResultInterface;

class Claim extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';
    public function __construct(Context $context, private readonly SupportTakeoverService $takeoverService) { parent::__construct($context); }
    public function execute(): ResultInterface
    {
        $caseId = (int)$this->getRequest()->getParam('entity_id');
        try {
            $admin = $this->_auth->getUser();
            $this->takeoverService->claim($caseId, (int)$admin->getId(), trim((string)$admin->getFirstName() . ' ' . (string)$admin->getLastName()));
            $this->messageManager->addSuccessMessage(__('Live chat started. AI is paused for this customer conversation.'));
            if ($this->getRequest()->isAjax()) {
                /** @var Json $json */ $json = $this->resultFactory->create(ResultFactory::TYPE_JSON);
                return $json->setData(['status' => 'success', 'active' => true]);
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
