<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Provider;

use Afd\AI\Observer\SyncNodeConfig;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\Controller\Result\JsonFactory;

class Sync extends Action implements HttpPostActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::providers';

    public function __construct(
        Context $context,
        private readonly JsonFactory $jsonFactory,
        private readonly SyncNodeConfig $nodeConfigSync
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        $providerId = (int)$this->getRequest()->getParam('provider_id');
        if ($providerId < 1) {
            return $this->jsonFactory->create()
                ->setHttpResponseCode(400)
                ->setData([
                    'success' => false,
                    'message' => __('Save the provider before synchronizing it to Node.'),
                ]);
        }

        $sync = $this->nodeConfigSync->sync($providerId);
        $status = (int)($sync['http_status'] ?? ($sync['success'] ? 200 : 422));

        return $this->jsonFactory->create()
            ->setHttpResponseCode($status >= 400 ? $status : 200)
            ->setData($sync);
    }
}
