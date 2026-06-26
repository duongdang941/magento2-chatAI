<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\Request\Http as HttpRequest;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Json;
use Afd\AI\Api\ConversationRepositoryInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\Data\Form\FormKey;
use Magento\Customer\Model\Session as CustomerSession;
use Psr\Log\LoggerInterface;

class DeleteConversation implements HttpPostActionInterface, CsrfAwareActionInterface
{
    private $request;
    private $resultFactory;
    private $conversationRepository;
    private $resourceConnection;
    private $customerSession;
    private $formKey;
    private $logger;

    public function __construct(
        HttpRequest $request,
        ResultFactory $resultFactory,
        ConversationRepositoryInterface $conversationRepository,
        ResourceConnection $resourceConnection,
        CustomerSession $customerSession,
        FormKey $formKey,
        LoggerInterface $logger
    ) {
        $this->request = $request;
        $this->resultFactory = $resultFactory;
        $this->conversationRepository = $conversationRepository;
        $this->resourceConnection = $resourceConnection;
        $this->customerSession = $customerSession;
        $this->formKey = $formKey;
        $this->logger = $logger;
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
            if ((int)$conversation->getCustomerId() !== (int)$customerId) {
                return $resultJson->setData(['status' => 'error', 'message' => 'Unauthorized']);
            }

            if ((string)$conversation->getData('conversation_type') === 'support') {
                $connection = $this->resourceConnection->getConnection();
                $now = gmdate('Y-m-d H:i:s');
                $connection->beginTransaction();
                try {
                    $connection->update(
                        $this->resourceConnection->getTableName('afd_ai_support_case'),
                        [
                            'status' => 'closed',
                            'takeover_state' => 'inactive',
                            'takeover_expires_at' => null,
                            'takeover_ended_at' => $now,
                            'resolved_at' => $now,
                            'updated_at' => $now,
                        ],
                        ['conversation_id = ?' => $conversationId]
                    );
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

            return $resultJson->setData(['status' => 'success']);
        } catch (\Exception $e) {
            $this->logger->error('DELETE CONVERSATION ERROR: ' . $e->getMessage());
            return $resultJson->setData(['status' => 'error', 'message' => 'Could not delete conversation']);
        }
    }
}
