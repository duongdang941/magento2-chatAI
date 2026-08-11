<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Knowledge\StoreKnowledgeSearch;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Store\InternalStoreContext;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Exception\AuthorizationException;

class Knowledge implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly NodeRequestAuthorizer $authorizer,
        private readonly StoreKnowledgeSearch $knowledgeSearch,
        private readonly InternalStoreContext $storeContext
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
            return $result->setData($this->storeContext->execute(
                (string)($payload['storeCode'] ?? ''),
                fn (): array => $this->knowledgeSearch->search(
                    (string)($payload['query'] ?? ''),
                    (int)($payload['limit'] ?? 5)
                )
            ));
        } catch (AuthorizationException) {
            return $result->setHttpResponseCode(403)->setData(['status' => 'error', 'message' => 'The knowledge request could not be verified.']);
        } catch (\Throwable) {
            return $result->setHttpResponseCode(400)->setData(['status' => 'error', 'message' => 'Store knowledge could not be searched.']);
        }
    }
}
