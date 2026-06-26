<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Tool\CartTool;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Data\Form\FormKey;
use Psr\Log\LoggerInterface;

/**
 * Mutates either the normal Magento cart or Amasty Request a Quote cart
 * belonging to the active browser session. The cart target must be provided
 * by the chat gateway; normal checkout is the safe default.
 * Browser requests use Magento's form key. The gateway asks the browser to
 * perform the mutation so the active storefront cart session remains authoritative.
 */
class AddToCart implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly CartTool $cartTool,
        private readonly FormKey $formKey,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return $request instanceof HttpRequest && $this->isValidBrowserRequest($request);
    }

    public function execute(): Json
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        if (!$this->isValidBrowserRequest($this->request)) {
            return $resultJson->setHttpResponseCode(403)->setData([
                'status' => 'error',
                'message' => 'The cart request could not be verified.',
            ]);
        }

        try {
            $payload = json_decode($this->request->getContent(), true, 16, JSON_THROW_ON_ERROR);
            $sku = trim((string)($payload['sku'] ?? ''));
            $qty = max(1, min((int)($payload['qty'] ?? 1), 1000000));
            $useDefaultQty = ($payload['useDefaultQty'] ?? false) === true;
            $cartTarget = (string)($payload['cartTarget'] ?? '') === 'quote' ? 'quote' : 'checkout';
            $action = (string)($payload['action'] ?? '') === 'remove' ? 'remove' : 'add';
            $selectedOptions = $this->normalizeSelectedOptions($payload['selectedOptions'] ?? []);

            if ($sku === '') {
                return $resultJson->setData([
                    'status' => 'error',
                    'message' => 'A product could not be selected.',
                ]);
            }

            return $resultJson->setData($action === 'remove'
                ? $this->cartTool->removeSelectedProductFromCart($sku, $cartTarget)
                : $this->cartTool->addSelectedProductToCart(
                    $sku,
                    $qty,
                    $selectedOptions,
                    $cartTarget,
                    $useDefaultQty
                ));
        } catch (\Throwable $exception) {
            $this->logger->warning('Afd AI cart request failed.', [
                'exception' => $exception,
            ]);

            return $resultJson->setData([
                'status' => 'error',
                'message' => 'The selected cart action could not be completed.',
            ]);
        }
    }

    private function isValidBrowserRequest(HttpRequest $request): bool
    {
        $formKey = trim((string)$request->getHeader('X-Form-Key'));

        return $request->getHeader('X-Requested-With') === 'XMLHttpRequest'
            && $formKey !== ''
            && hash_equals($this->formKey->getFormKey(), $formKey);
    }

    /** @return array<string, string> */
    private function normalizeSelectedOptions(mixed $options): array
    {
        if (!is_array($options) || array_is_list($options)) {
            return [];
        }

        $normalized = [];
        foreach (array_slice($options, 0, 8, true) as $code => $value) {
            $code = trim((string)$code);
            $value = trim((string)$value);
            if (preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $code) && $value !== '' && mb_strlen($value) <= 120) {
                $normalized[$code] = $value;
            }
        }

        return $normalized;
    }
}
