<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Api\ProviderRepositoryInterface;
use Afd\AI\Model\Provider\ProviderHealthChecker;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;

class Health extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::providers';

    public function __construct(
        Context $context,
        private readonly ProviderRepositoryInterface $providerRepository,
        private readonly ProviderHealthChecker $healthChecker,
        private readonly JsonFactory $jsonFactory
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        try {
            $provider = $this->providerRepository->getById((int)$this->getRequest()->getParam('provider_id'));
            return $this->jsonFactory->create()->setData($this->healthChecker->check($provider));
        } catch (\Throwable) {
            return $this->jsonFactory->create()->setHttpResponseCode(404)->setData([
                'success' => false,
                'status' => 0,
                'latency_ms' => 0,
                'message' => __('Provider was not found.'),
            ]);
        }
    }
}
