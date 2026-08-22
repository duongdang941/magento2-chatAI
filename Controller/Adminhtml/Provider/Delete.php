<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Event\ManagerInterface as EventManager;

class Delete extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = "Afd_AI::providers";

    public function __construct(
        Context $context,
        private readonly ProviderRepositoryInterface $providerRepository,
        private readonly JsonFactory $jsonFactory,
        private readonly EventManager $eventManager
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        $providerId = (int)$this->getRequest()->getParam("provider_id");
        $isAjax = $this->getRequest()->isXmlHttpRequest();

        try {
            if ($providerId > 0) {
                $this->providerRepository->deleteById($providerId);
                $this->eventManager->dispatch("admin_system_config_changed_section_afd_ai");
                $message = __("AI Provider deleted successfully.");
                $this->messageManager->addSuccessMessage($message);
            } else {
                throw new \InvalidArgumentException(__("Invalid provider ID."));
            }

            if ($isAjax) {
                return $this->jsonFactory->create()->setData([
                    "success" => true,
                    "message" => $message
                ]);
            }
        } catch (\Throwable $e) {
            $errorMsg = __("Error deleting provider: %1", $e->getMessage());
            $this->messageManager->addErrorMessage($errorMsg);
            if ($isAjax) {
                return $this->jsonFactory->create()->setData([
                    "success" => false,
                    "message" => $e->getMessage()
                ]);
            }
        }

        /** @var \Magento\Backend\Model\View\Result\Redirect $resultRedirect */
        $resultRedirect = $this->resultFactory->create(ResultFactory::TYPE_REDIRECT);
        return $resultRedirect->setPath("afd_ai/provider/index");
    }
}
