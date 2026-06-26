<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Order\CustomerOrderService;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Exception\AuthorizationException;
use Psr\Log\LoggerInterface;

/**
 * HMAC-protected Node gateway endpoint for customer order operations.
 * Browser requests cannot call this route: the gateway signs the request only
 * after it has verified the customer's single-use WebSocket ticket.
 */
class Orders implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $nodeRequestAuthorizer,
        private readonly CustomerOrderService $customerOrderService,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        // HMAC authorization is enforced in execute(). This only prevents
        // Magento's form-key layer from rejecting Node's signed JSON request.
        return $request instanceof HttpRequest;
    }

    public function execute(): Json
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $this->nodeRequestAuthorizer->assertAuthorized();
        } catch (AuthorizationException) {
            return $resultJson->setHttpResponseCode(403)->setData([
                'status' => 'error',
                'message' => 'The order request could not be verified.',
            ]);
        }

        try {
            $payload = json_decode($this->request->getContent(), true, 16, JSON_THROW_ON_ERROR);
            $customerId = max(0, (int)($payload['customerId'] ?? 0));
            $action = (string)($payload['action'] ?? '');

            return $resultJson->setData(match ($action) {
                'list' => $this->customerOrderService->listRecentOrders(
                    $customerId,
                    max(1, min((int)($payload['limit'] ?? 5), 10))
                ),
                'details' => $this->customerOrderService->getOrderDetails(
                    $customerId,
                    (string)($payload['orderNumber'] ?? '')
                ),
                'update_address' => $this->customerOrderService->updateOrderAddress(
                    $customerId,
                    (string)($payload['orderNumber'] ?? ''),
                    (string)($payload['addressType'] ?? ''),
                    is_array($payload['address'] ?? null) ? $payload['address'] : []
                ),
                'fulfillment' => $this->customerOrderService->getFulfillmentDetails(
                    $customerId,
                    (string)($payload['orderNumber'] ?? '')
                ),
                'cancel' => $this->customerOrderService->cancelOrder(
                    $customerId,
                    (string)($payload['orderNumber'] ?? ''),
                    ($payload['confirmed'] ?? false) === true
                ),
                'request_return' => $this->customerOrderService->requestReturn(
                    $customerId,
                    (string)($payload['orderNumber'] ?? ''),
                    (int)($payload['conversationId'] ?? 0),
                    (string)($payload['reason'] ?? ''),
                    is_array($payload['skus'] ?? null) ? $payload['skus'] : []
                ),
                default => [
                    'status' => 'error',
                    'message' => 'The requested order action is not available.',
                ],
            });
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI customer-order request failed.', ['exception' => $exception]);

            return $resultJson->setData([
                'status' => 'error',
                'message' => 'The order request could not be completed.',
            ]);
        }
    }
}
