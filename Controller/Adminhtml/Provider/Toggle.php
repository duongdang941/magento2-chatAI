<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;
use Magento\Framework\Event\ManagerInterface as EventManager;

class Toggle extends Action implements HttpPostActionInterface
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
        $result = $this->jsonFactory->create();
        $providerId = (int)$this->getRequest()->getParam("provider_id");

        try {
            $provider = $this->providerRepository->getById($providerId);
            $provider->setIsActive(!$provider->getIsActive());
            $this->providerRepository->save($provider);
            $this->eventManager->dispatch("admin_system_config_changed_section_afd_ai");

            return $result->setData([
                "success" => true,
                "is_active" => $provider->getIsActive() ? 1 : 0,
                "message" => __("Provider status updated.")
            ]);
        } catch (\Throwable $e) {
            return $result->setData([
                "success" => false,
                "message" => $e->getMessage()
            ]);
        }
    }
}
