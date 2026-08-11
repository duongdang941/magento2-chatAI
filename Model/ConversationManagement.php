<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ConversationManagementInterface;
use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Api\Data\ConversationInterfaceFactory;
use Afd\AI\Api\Data\MessageInterfaceFactory;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\Conversation\MessagePageLoader;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Framework\App\ResourceConnection;
use Psr\Log\LoggerInterface;

class ConversationManagement implements ConversationManagementInterface
{
    private $conversationRepository;
    private $conversationFactory;
    private $messageRepository;
    private $messageFactory;
    private $searchCriteriaBuilder;
    private $sortOrderBuilder;
    private ResourceConnection $resourceConnection;
    private MessagePageLoader $messagePageLoader;
    private ChatAttachmentStorage $chatAttachmentStorage;
    private NodeRequestAuthorizer $nodeRequestAuthorizer;
    private SupportInboxService $supportInboxService;
    private $logger;

    public function __construct(
        ConversationRepositoryInterface $conversationRepository,
        ConversationInterfaceFactory $conversationFactory,
        MessageRepositoryInterface $messageRepository,
        MessageInterfaceFactory $messageFactory,
        SearchCriteriaBuilder $searchCriteriaBuilder,
        SortOrderBuilder $sortOrderBuilder,
        ResourceConnection $resourceConnection,
        MessagePageLoader $messagePageLoader,
        ChatAttachmentStorage $chatAttachmentStorage,
        NodeRequestAuthorizer $nodeRequestAuthorizer,
        SupportInboxService $supportInboxService,
        LoggerInterface $logger
    ) {
        $this->conversationRepository = $conversationRepository;
        $this->conversationFactory = $conversationFactory;
        $this->messageRepository = $messageRepository;
        $this->messageFactory = $messageFactory;
        $this->searchCriteriaBuilder = $searchCriteriaBuilder;
        $this->sortOrderBuilder = $sortOrderBuilder;
        $this->resourceConnection = $resourceConnection;
        $this->messagePageLoader = $messagePageLoader;
        $this->chatAttachmentStorage = $chatAttachmentStorage;
        $this->nodeRequestAuthorizer = $nodeRequestAuthorizer;
        $this->supportInboxService = $supportInboxService;
        $this->logger = $logger;
    }

    public function healthCheck(): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        return true;
    }

    /**
     * @inheritdoc
     */
    public function createConversation(int $customerId, string $title): int
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->conversationFactory->create();
            $conversation->setCustomerId($customerId);
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return (int)$conversation->getConversationId();
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::createConversation error: ' . $e->getMessage());
            throw $e;
        }
    }

    /**
     * @inheritdoc
     */
    public function listConversations(
        int $customerId,
        int $pageSize = 20,
        int $currentPage = 1
    ): array {
        $this->nodeRequestAuthorizer->assertAuthorized();

        $pageSize = max(1, min($pageSize, 20));
        $currentPage = max(1, $currentPage);

        $sortOrder = $this->sortOrderBuilder
            ->setField('updated_at')
            ->setDescendingDirection()
            ->create();

        $searchCriteria = $this->searchCriteriaBuilder
            ->addFilter('customer_id', $customerId)
            ->addFilter('is_archived', 0)
            ->addSortOrder($sortOrder)
            ->setPageSize($pageSize)
            ->setCurrentPage($currentPage)
            ->create();

        $list = $this->conversationRepository->getList($searchCriteria);
        $result = [];

        foreach ($list->getItems() as $conv) {
            $result[] = [
                'id' => (int)$conv->getConversationId(),
                'title' => $conv->getTitle(),
                'type' => (string)($conv->getData('conversation_type') ?: 'ai'),
                'created_at' => $conv->getCreatedAt(),
                'updated_at' => $conv->getUpdatedAt()
            ];
        }

        $hasMore = ($currentPage * $pageSize) < (int)$list->getTotalCount();

        // Magento Web API serializes associative PHP arrays as ordered JSON
        // arrays. Keep this positional response deliberate and normalize it in
        // the Node gateway before it reaches the browser.
        return [$result, $hasMore, $hasMore ? $currentPage + 1 : null];
    }

    /**
     * @inheritdoc
     */
    public function getConversation(int $conversationId, int $customerId): array
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        if ($conversationId < 1 || $customerId < 1) {
            return [];
        }

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
        } catch (\Exception $exception) {
            return [];
        }

        if ((int)$conversation->getCustomerId() !== $customerId) {
            return [];
        }

        return [
            'id' => (int)$conversation->getConversationId(),
            'title' => (string)$conversation->getTitle(),
            'type' => (string)($conversation->getData('conversation_type') ?: 'ai'),
            'created_at' => (string)$conversation->getCreatedAt(),
            'updated_at' => (string)$conversation->getUpdatedAt()
        ];
    }

    /**
     * @inheritdoc
     */
    public function loadMessages(
        int $conversationId,
        int $customerId,
        ?int $beforeMessageId = null,
        int $pageSize = 50
    ): array {
        $this->nodeRequestAuthorizer->assertAuthorized();

        return $this->messagePageLoader->load(
            $conversationId,
            $customerId,
            $beforeMessageId,
            $pageSize
        ) ?: [
            'messages' => [],
            'has_more' => false,
            'next_before_message_id' => null
        ];
    }

    /**
     * @inheritdoc
     */
    public function saveMessage(
        int $conversationId,
        int $customerId,
        string $role,
        string $content,
        ?string $attachment = null
    ): int {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            // Verify conversation ownership
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== $customerId) {
                throw new \Magento\Framework\Exception\LocalizedException(__('Unauthorized'));
            }

            $message = $this->messageFactory->create();
            $message->setSessionId('node-ws');
            $message->setCustomerId($customerId);
            $message->setConversationId($conversationId);
            $message->setRole($role);
            $message->setContent($content);
            if ($role === 'user' && $attachment !== null && trim($attachment) !== '') {
                $message->setAttachment(
                    $this->chatAttachmentStorage->storeFromJson($attachment, $customerId, $conversationId)
                );
            }
            $this->messageRepository->save($message);

            if ($role === 'user') {
                $this->supportInboxService->recordCustomerMessage($conversationId);
            }

            return (int)$message->getEntityId();
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::saveMessage error: ' . $e->getMessage());
            throw $e;
        }
    }

    /** @return bool */
    public function truncateConversationFromMessage(
        int $conversationId,
        int $customerId,
        int $fromMessageId
    ): bool {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== $customerId) {
                return false;
            }

            if (!$this->truncateMessageBranch($conversationId, $fromMessageId)) {
                return false;
            }

            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $exception) {
            $this->logger->error(
                'ConversationManagement::truncateConversationFromMessage error: ' . $exception->getMessage()
            );
            return false;
        }
    }

    /**
     * @inheritdoc
     */
    public function deleteConversation(int $conversationId, int $customerId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== $customerId) {
                return false;
            }

            if ((string)$conversation->getData('conversation_type') === 'support') {
                return $this->closeSupportConversation($conversation);
            }

            $connection = $this->resourceConnection->getConnection();
            $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
            $connection->delete($messageTable, ['conversation_id = ?' => $conversationId]);
            $this->chatAttachmentStorage->deleteConversationAttachments((int)$customerId, $conversationId);
            $this->conversationRepository->delete($conversation);
            return true;
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::deleteConversation error: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * @inheritdoc
     */
    public function touchConversation(int $conversationId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $e) {
            return false;
        }
    }

    /**
     * @inheritdoc
     */
    public function updateConversationTitle(int $conversationId, int $customerId, string $title): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            if ((int)$conversation->getCustomerId() !== $customerId) {
                return false;
            }
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::updateConversationTitle error: ' . $e->getMessage());
            return false;
        }
    }

    public function createGuestConversation(string $guestId, string $title): int
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);

        try {
            $conversation = $this->conversationFactory->create();
            $conversation->setCustomerId(null);
            $conversation->setGuestId($guestId);
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return (int)$conversation->getConversationId();
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::createGuestConversation error: ' . $exception->getMessage());
            throw $exception;
        }
    }

    public function listGuestConversations(string $guestId, int $pageSize = 20, int $currentPage = 1): array
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);
        $pageSize = max(1, min($pageSize, 20));
        $currentPage = max(1, $currentPage);

        $sortOrder = $this->sortOrderBuilder
            ->setField('updated_at')
            ->setDescendingDirection()
            ->create();
        $criteria = $this->searchCriteriaBuilder
            ->addFilter('guest_id', $guestId)
            ->addFilter('conversation_type', 'ai')
            ->addFilter('is_archived', 0)
            ->addSortOrder($sortOrder)
            ->setPageSize($pageSize)
            ->setCurrentPage($currentPage)
            ->create();
        $list = $this->conversationRepository->getList($criteria);
        $items = [];
        foreach ($list->getItems() as $conversation) {
            $items[] = $this->conversationData($conversation);
        }
        // Guests have one continuous conversation. Keep legacy duplicate rows
        // inaccessible and let an explicit guest reset remove them together.
        return [array_slice($items, 0, 1), false, null];
    }

    public function getGuestConversation(int $conversationId, string $guestId): array
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        return $conversation ? $this->conversationData($conversation) : [];
    }

    public function loadGuestMessages(
        int $conversationId,
        string $guestId,
        ?int $beforeMessageId = null,
        int $pageSize = 50
    ): array {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $page = $this->messagePageLoader->loadGuest(
            $conversationId,
            $this->normalizeGuestId($guestId),
            $beforeMessageId,
            $pageSize
        );
        return $page ?: ['messages' => [], 'has_more' => false, 'next_before_message_id' => null];
    }

    public function saveGuestMessage(
        int $conversationId,
        string $guestId,
        string $role,
        string $content,
        ?string $attachment = null
    ): int {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        if (!$conversation) {
            throw new \Magento\Framework\Exception\LocalizedException(__('Unauthorized'));
        }

        $message = $this->messageFactory->create();
        $message->setSessionId('guest:' . $guestId);
        $message->setCustomerId(null);
        $message->setConversationId($conversationId);
        $message->setRole($role);
        $message->setContent($content);
        if ($role === 'user' && $attachment !== null && trim($attachment) !== '') {
            $message->setAttachment($this->chatAttachmentStorage->storeFromJson($attachment, $guestId, $conversationId));
        }
        $this->messageRepository->save($message);
        if ($role === 'user') {
            $this->supportInboxService->recordCustomerMessage($conversationId);
        }
        return (int)$message->getEntityId();
    }

    public function truncateGuestConversationFromMessage(
        int $conversationId,
        string $guestId,
        int $fromMessageId
    ): bool {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        if (!$conversation || !$this->truncateMessageBranch($conversationId, $fromMessageId)) {
            return false;
        }

        try {
            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $exception) {
            $this->logger->error(
                'ConversationManagement::truncateGuestConversationFromMessage error: ' . $exception->getMessage()
            );
            return false;
        }
    }

    public function deleteGuestConversation(int $conversationId, string $guestId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        if (!$conversation) {
            return false;
        }

        if ((string)$conversation->getData('conversation_type') === 'support') {
            return $this->closeSupportConversation($conversation);
        }

        try {
            $connection = $this->resourceConnection->getConnection();
            $connection->delete($this->resourceConnection->getTableName('afd_ai_message'), ['conversation_id = ?' => $conversationId]);
            $this->chatAttachmentStorage->deleteConversationAttachments($guestId, $conversationId);
            $this->conversationRepository->delete($conversation);
            return true;
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::deleteGuestConversation error: ' . $exception->getMessage());
            return false;
        }
    }

    public function deleteGuestConversations(string $guestId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $guestId = $this->normalizeGuestId($guestId);

        try {
            $connection = $this->resourceConnection->getConnection();
            $conversationTable = $this->resourceConnection->getTableName('afd_ai_conversation');
            $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
            $conversationIds = $connection->fetchCol(
                $connection->select()
                    ->from($conversationTable, ['conversation_id'])
                    ->where('guest_id = ?', $guestId)
                    ->where('conversation_type = ?', 'ai')
            );

            if ($conversationIds) {
                $connection->delete($messageTable, ['conversation_id IN (?)' => $conversationIds]);
                foreach ($conversationIds as $conversationId) {
                    $this->chatAttachmentStorage->deleteConversationAttachments($guestId, (int)$conversationId);
                }
                $connection->delete($conversationTable, ['conversation_id IN (?)' => $conversationIds]);
            }
            return true;
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::deleteGuestConversations error: ' . $exception->getMessage());
            return false;
        }
    }

    public function touchGuestConversation(int $conversationId, string $guestId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        if (!$conversation) {
            return false;
        }
        $this->conversationRepository->save($conversation);
        return true;
    }

    public function updateGuestConversationTitle(int $conversationId, string $guestId, string $title): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $conversation = $this->getGuestOwnedConversation($conversationId, $guestId);
        if (!$conversation) {
            return false;
        }
        $conversation->setTitle(mb_substr($title, 0, 255));
        $this->conversationRepository->save($conversation);
        return true;
    }

    private function normalizeGuestId(string $guestId): string
    {
        $guestId = strtolower(trim($guestId));
        if (!preg_match('/^[a-f0-9]{64}$/', $guestId)) {
            throw new \Magento\Framework\Exception\LocalizedException(__('Invalid guest identity.'));
        }
        return $guestId;
    }

    /**
     * A branch can begin only at a user message. This prevents a browser from
     * using the edit transport to remove an arbitrary portion of a
     * conversation, while the ownership check remains in the public methods.
     */
    private function truncateMessageBranch(int $conversationId, int $fromMessageId): bool
    {
        if ($conversationId < 1 || $fromMessageId < 1) {
            return false;
        }

        $connection = $this->resourceConnection->getConnection();
        $messageTable = $this->resourceConnection->getTableName('afd_ai_message');
        $role = $connection->fetchOne(
            $connection->select()
                ->from($messageTable, ['role'])
                ->where('conversation_id = ?', $conversationId)
                ->where('entity_id = ?', $fromMessageId)
        );
        if ($role !== 'user') {
            return false;
        }

        $connection->delete($messageTable, [
            'conversation_id = ?' => $conversationId,
            'entity_id >= ?' => $fromMessageId
        ]);
        return true;
    }

    private function getGuestOwnedConversation(int $conversationId, string $guestId)
    {
        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            $guestId = $this->normalizeGuestId($guestId);
            return hash_equals((string)$conversation->getGuestId(), $guestId) ? $conversation : null;
        } catch (\Exception $exception) {
            return null;
        }
    }

    private function conversationData($conversation): array
    {
        return [
            'id' => (int)$conversation->getConversationId(),
            'title' => (string)$conversation->getTitle(),
            'type' => (string)($conversation->getData('conversation_type') ?: 'ai'),
            'created_at' => (string)$conversation->getCreatedAt(),
            'updated_at' => (string)$conversation->getUpdatedAt()
        ];
    }

    private function closeSupportConversation($conversation): bool
    {
        $conversationId = (int)$conversation->getConversationId();
        if ($conversationId < 1) {
            return false;
        }

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
            return true;
        } catch (\Throwable $exception) {
            $connection->rollBack();
            $this->logger->error(
                'ConversationManagement::closeSupportConversation error: ' . $exception->getMessage()
            );
            return false;
        }
    }
}
