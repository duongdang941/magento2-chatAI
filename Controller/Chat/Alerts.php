<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Product\BackInStockSubscription;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Exception\AuthorizationException;

class Alerts implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $authorizer,
        private readonly BackInStockSubscription $subscription
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException { return null; }
    public function validateForCsrf(RequestInterface $request): ?bool { return $request instanceof HttpRequest; }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        try {
            $this->authorizer->assertAuthorized();
            $payload = json_decode($this->request->getContent(), true, 8, JSON_THROW_ON_ERROR);
            return $result->setData($this->subscription->subscribe(
                max(0, (int)($payload['customerId'] ?? 0)),
                (string)($payload['sku'] ?? '')
            ));
        } catch (AuthorizationException) {
            return $result->setHttpResponseCode(403)->setData(['status' => 'error', 'message' => 'The alert request could not be verified.']);
        } catch (\Throwable) {
            return $result->setHttpResponseCode(400)->setData(['status' => 'error', 'message' => 'The product alert could not be created.']);
        }
    }
}
