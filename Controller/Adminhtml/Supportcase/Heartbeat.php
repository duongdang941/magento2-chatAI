<?php
declare(strict_types=1);
namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\Support\SupportTakeoverService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class Heartbeat extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';
    public function __construct(Context $context, private readonly SupportTakeoverService $takeoverService) { parent::__construct($context); }
    public function execute(): Json
    {
        /** @var Json $result */ $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        $active = $this->takeoverService->heartbeat((int)$this->getRequest()->getParam('entity_id'), (int)$this->_auth->getUser()->getId());
        return $result->setData(['status' => $active ? 'success' : 'expired', 'active' => $active]);
    }
}
