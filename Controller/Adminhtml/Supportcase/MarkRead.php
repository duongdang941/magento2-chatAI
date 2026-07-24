<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Support\SupportInboxService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class MarkRead extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';

    public function __construct(Context $context, private readonly SupportInboxService $inboxService)
    {
        parent::__construct($context);
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        $caseId = (int)$this->getRequest()->getParam('entity_id');
        if ($caseId < 1) {
            return $result->setHttpResponseCode(400)->setData(['status' => 'error']);
        }
        $this->inboxService->markAdminRead($caseId);
        return $result->setData(['status' => 'success', 'entity_id' => $caseId]);
    }
}
