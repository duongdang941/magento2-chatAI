<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Store\InternalStoreContext;
use Afd\AI\Model\Support\SupportCaseService;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Exception\AuthorizationException;
use Psr\Log\LoggerInterface;

class Support implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $authorizer,
        private readonly SupportCaseService $supportCaseService,
        private readonly InternalStoreContext $storeContext,
        private readonly LoggerInterface $logger
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
            $payload = json_decode($this->request->getContent(), true, 16, JSON_THROW_ON_ERROR);
            $customerId = max(0, (int)($payload['customerId'] ?? 0));
            return $result->setData($this->storeContext->execute(
                (string)($payload['storeCode'] ?? ''),
                function () use ($payload, $customerId): array {
                    if (($payload['operation'] ?? '') === 'list') {
                        return $this->supportCaseService->listVerified(
                            $customerId > 0 ? $customerId : null,
                            $customerId > 0 ? null : (string)($payload['guestId'] ?? ''),
                            (string)($payload['email'] ?? ''),
                            (string)($payload['verificationToken'] ?? ''),
                            (string)($payload['verificationSessionId'] ?? '')
                        );
                    }

                    return $this->supportCaseService->create(
                        (int)($payload['conversationId'] ?? 0),
                        $customerId > 0 ? $customerId : null,
                        $customerId > 0 ? null : (string)($payload['guestId'] ?? ''),
                        (string)($payload['category'] ?? 'general'),
                        (string)($payload['subject'] ?? ''),
                        (string)($payload['summary'] ?? ''),
                        (string)($payload['priority'] ?? 'normal'),
                        is_array($payload['context'] ?? null) ? $payload['context'] : [],
                        (int)($payload['messageId'] ?? 0) ?: null,
                        (string)($payload['email'] ?? ''),
                        (string)($payload['verificationToken'] ?? ''),
                        (string)($payload['verificationSessionId'] ?? '')
                    );
                }
            ));
        } catch (AuthorizationException) {
            return $result->setHttpResponseCode(403)->setData(['status' => 'error', 'message' => 'The support request could not be verified.']);
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI support request failed.', ['exception' => $exception]);
            return $result->setHttpResponseCode(400)->setData(['status' => 'error', 'message' => 'The support request could not be created.']);
        }
    }
}
