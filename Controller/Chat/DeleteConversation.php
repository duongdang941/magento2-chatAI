<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Model\ChatAttachmentStorage;
use Afd\AI\Model\Conversation\ConversationStoreScope;
use Afd\AI\Model\Support\SupportTakeoverService;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Data\Form\FormKey;
use Psr\Log\LoggerInterface;

class DeleteConversation implements HttpPostActionInterface, CsrfAwareActionInterface
{
    public function __construct(
        private readonly HttpRequest $request,
        private readonly ResultFactory $resultFactory,
        private readonly ConversationRepositoryInterface $conversationRepository,
        private readonly ResourceConnection $resourceConnection,
        private readonly CustomerSession $customerSession,
        private readonly FormKey $formKey,
        private readonly ChatAttachmentStorage $chatAttachmentStorage,
        private readonly ConversationStoreScope $conversationStoreScope,
        private readonly SupportTakeoverService $supportTakeoverService,
        private readonly LoggerInterface $logger
    ) {
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        $headerFormKey = (string)$request->getHeader('X-Form-Key');

        return $request->getHeader('X-Requested-With') === 'XMLHttpRequest'
            && $headerFormKey !== ''
            && hash_equals($this->formKey->getFormKey(), $headerFormKey);
    }

    public function execute()
    {
        /** @var Json $resultJson */
        $resultJson = $this->resultFactory->create(ResultFactory::TYPE_JSON);

        try {
            $input = json_decode($this->request->getContent(), true) ?? [];
            $conversationId = (int)($input['conversation_id'] ?? 0);
            $customerId = $this->customerSession->getCustomerId();

            if (!$conversationId || !$customerId) {
                return $resultJson->setData(['status' => 'error', 'message' => 'Invalid request']);
            }

            // Verify ownership
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== (int)$customerId
                || !$this->conversationStoreScope->matches($conversation)) {
                return $resultJson->setData(['status' => 'error', 'message' => 'Unauthorized']);
            }

            if ((string)$conversation->getData('conversation_type') === 'support') {
                $connection = $this->resourceConnection->getConnection();
                $now = gmdate('Y-m-d H:i:s');
                $connection->beginTransaction();
                try {
                    $this->supportTakeoverService->closeByConversationId($conversationId);
                    $conversation->setData('is_archived', 1);
                    $conversation->setData('updated_at', $now);
                    $this->conversationRepository->save($conversation);
                    $connection->commit();
                } catch (\Throwable $exception) {
                    $connection->rollBack();
                    throw $exception;
                }

                return $resultJson->setData(['status' => 'success', 'action' => 'closed']);
            }

            // Bulk delete all messages in this conversation (single SQL query)
            $connection = $this->resourceConnection->getConnection();
            $tableName = $this->resourceConnection->getTableName('afd_ai_message');
            $connection->delete($tableName, ['conversation_id = ?' => $conversationId]);

            // Delete conversation
            $this->conversationRepository->delete($conversation);
            $this->chatAttachmentStorage->deleteConversationAttachments((int)$customerId, $conversationId);

            return $resultJson->setData(['status' => 'success']);
        } catch (\Exception $e) {
            $this->logger->error('DELETE CONVERSATION ERROR', ['exception' => $e]);
            return $resultJson->setData(['status' => 'error', 'message' => 'Could not delete conversation']);
        }
    }
}