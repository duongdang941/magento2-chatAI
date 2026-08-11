<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Order\GuestOrderAccessService;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Exception\AuthorizationException;

/** Internal HMAC-protected endpoint used only by the Node gateway. */
class GuestOrders implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly Http $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $authorizer,
        private readonly GuestOrderAccessService $service
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return $request instanceof Http;
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $this->authorizer->assertAuthorized();
        } catch (AuthorizationException) {
            return $result
                ->setHttpResponseCode(403)
                ->setData(['status' => 'error', 'message' => 'The request could not be verified.']);
        }

        try {
            $payload = json_decode($this->request->getContent(), true, 32, JSON_THROW_ON_ERROR);
            if (!is_array($payload)) {
                throw new \InvalidArgumentException('Invalid request payload.');
            }

            $action = (string)($payload['action'] ?? '');
            $sessionId = (string)($payload['sessionId'] ?? '');
            $accessToken = (string)($payload['accessToken'] ?? '');
            $email = (string)($payload['email'] ?? '');

            $response = match ($action) {
                'request_otp' => $this->service->requestOtp($email, $sessionId),
                'verify_otp' => $this->service->verifyOtp(
                    $email,
                    (string)($payload['code'] ?? ''),
                    $sessionId
                ),
                'list' => $this->service->listOrders(
                    $accessToken,
                    $sessionId,
                    $email,
                    (int)($payload['limit'] ?? 5)
                ),
                'details' => $this->service->getOrderDetails(
                    $accessToken,
                    $sessionId,
                    $email,
                    (string)($payload['orderNumber'] ?? $payload['order_number'] ?? '')
                ),
                'update_address' => $this->service->updateOrderAddress(
                    $accessToken,
                    $sessionId,
                    $email,
                    (string)($payload['orderNumber'] ?? $payload['order_number'] ?? ''),
                    (string)($payload['addressType'] ?? $payload['address_type'] ?? ''),
                    is_array($payload['address'] ?? null) ? $payload['address'] : []
                ),
                default => ['status' => 'error', 'message' => 'Action unavailable.'],
            };

            return $result->setData($response);
        } catch (\Throwable) {
            return $result->setData([
                'status' => 'error',
                'message' => 'The request could not be completed.',
            ]);
        }
    }
}
