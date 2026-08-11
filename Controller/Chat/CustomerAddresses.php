<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Customer\CustomerAddressService;
use Afd\AI\Model\Customer\CustomerAddressRateLimiter;
use Afd\AI\Model\Security\AddressFormTokenValidator;
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

/** HMAC-only account address endpoint for verified logged-in customers. */
class CustomerAddresses implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $nodeRequestAuthorizer,
        private readonly CustomerAddressService $customerAddressService,
        private readonly AddressFormTokenValidator $addressFormTokenValidator,
        private readonly CustomerAddressRateLimiter $customerAddressRateLimiter,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return $request instanceof HttpRequest;
    }

    public function execute(): Json
    {
        /** @var Json $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        try {
            $this->nodeRequestAuthorizer->assertAuthorized();
        } catch (AuthorizationException) {
            return $result->setHttpResponseCode(403)->setData([
                'status' => 'error',
                'message' => 'The customer address request could not be verified.',
            ]);
        }

        try {
            $payload = json_decode($this->request->getContent(), true, 16, JSON_THROW_ON_ERROR);
            $customerId = max(0, (int)($payload['customerId'] ?? 0));
            $action = (string)($payload['action'] ?? '');

            if ($action === 'update') {
                $addressType = strtolower(trim((string)($payload['addressType'] ?? '')));
                $token = $this->addressFormTokenValidator->validateCustomerAccount(
                    (string)($payload['actionToken'] ?? ''),
                    mb_substr((string)($payload['formId'] ?? ''), 0, 160),
                    $customerId,
                    $addressType
                );
                if (!$token['valid']) {
                    return $result->setData([
                        'status' => 'requires_customer_action',
                        'reason' => $token['reason'],
                        'message' => $token['reason'] === 'form_expired'
                            ? 'This address form has expired. Ask for a new form to continue.'
                            : 'This address form could not be verified. Ask for a new form to continue.',
                    ]);
                }
                $rateLimit = $this->customerAddressRateLimiter->consume($customerId);
                if (!$rateLimit['allowed']) {
                    return $result->setData([
                        'status' => 'requires_customer_action',
                        'reason' => 'rate_limited',
                        'retry_after' => $rateLimit['retry_after'],
                        'message' => 'Too many address updates. Please wait before trying again.',
                    ]);
                }
            }

            return $result->setData(match ($action) {
                'get' => $this->customerAddressService->getDefaultAddresses($customerId),
                'update' => $this->customerAddressService->updateDefaultAddress(
                    $customerId,
                    (string)($payload['addressType'] ?? ''),
                    is_array($payload['address'] ?? null) ? $payload['address'] : []
                ),
                default => ['status' => 'error', 'message' => 'The requested address action is not available.'],
            });
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI customer address request failed.', ['exception' => $exception]);
            return $result->setData([
                'status' => 'error',
                'message' => 'The customer address request could not be completed.',
            ]);
        }
    }
}
