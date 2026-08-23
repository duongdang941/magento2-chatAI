<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\ConversationManagementInterface;
use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Api\Data\ConversationInterfaceFactory;
use Afd\AI\Api\Data\MessageInterface;
use Afd\AI\Api\Data\MessageInterfaceFactory;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\Conversation\MessagePageLoader;
use Afd\AI\Model\Maintenance\GeneratedImageReferenceRepository;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\ResourceModel\Conversation as ConversationResource;
use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Store\Model\StoreManagerInterface;
use Psr\Log\LoggerInterface;

class ConversationManagement implements ConversationManagementInterface
{
    public function __construct(
        private readonly ConversationRepositoryInterface $conversationRepository,
        private readonly ConversationInterfaceFactory $conversationFactory,
        private readonly MessageRepositoryInterface $messageRepository,
        private readonly MessageInterfaceFactory $messageFactory,
        private readonly SearchCriteriaBuilder $searchCriteriaBuilder,
        private readonly SortOrderBuilder $sortOrderBuilder,
        private readonly ConversationResource $conversationResource,
        private readonly SupportCaseResource $supportCaseResource,
        private readonly MessagePageLoader $messagePageLoader,
        private readonly ChatAttachmentStorage $chatAttachmentStorage,
        private readonly NodeRequestAuthorizer $nodeRequestAuthorizer,
        private readonly SupportInboxService $supportInboxService,
        private readonly StoreManagerInterface $storeManager,
        private readonly GeneratedImageReferenceRepository $generatedImageReferenceRepository,
        private readonly LoggerInterface $logger
    ) {
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
        $scope = $this->currentStoreScope();

        try {
            $conversation = $this->conversationFactory->create();
            $conversation->setCustomerId($customerId);
            $conversation->setData('store_id', $scope['store_id']);
            $conversation->setData('website_id', $scope['website_id']);
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return (int)$conversation->getConversationId();
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::createConversation error', ['exception' => $e]);
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
        $scope = $this->currentStoreScope();

        $pageSize = max(1, min($pageSize, 20));
        $currentPage = max(1, $currentPage);

        $sortOrder = $this->sortOrderBuilder
            ->setField('updated_at')
            ->setDescendingDirection()
            ->create();

        $searchCriteria = $this->searchCriteriaBuilder
            ->addFilter('customer_id', $customerId)
            ->addFilter('store_id', $scope['store_id'])
            ->addFilter('website_id', $scope['website_id'])
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

        if ((int)$conversation->getCustomerId() !== $customerId || !$this->matchesCurrentStoreScope($conversation)) {
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

        if (!$this->getCustomerOwnedConversation($conversationId, $customerId)) {
            return ['messages' => [], 'has_more' => false, 'next_before_message_id' => null];
        }

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
            if ((int)$conversation->getCustomerId() !== $customerId || !$this->matchesCurrentStoreScope($conversation)) {
                throw new \Magento\Framework\Exception\LocalizedException(__('Unauthorized'));
            }

            $message = $this->messageFactory->create();
            $message->setSessionId('node-ws');
            $message->setCustomerId($customerId);
            $message->setConversationId($conversationId);
            $message->setRole($role);
            $message->setContent($content);
            if ($role === 'user') {
                $this->attachUserMessage($message, $attachment, $customerId, $conversationId);
            }
            $this->messageRepository->save($message);
            $this->generatedImageReferenceRepository->replaceForMessage(
                (int)$message->getEntityId(),
                $role,
                $content
            );

            if ($role === 'user') {
                $this->supportInboxService->recordCustomerMessage($conversationId);
            }

            return (int)$message->getEntityId();
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::saveMessage error', ['exception' => $e]);
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
            if ((int)$conversation->getCustomerId() !== $customerId || !$this->matchesCurrentStoreScope($conversation)) {
                return false;
            }

            if (!$this->truncateMessageBranch($conversationId, $fromMessageId)) {
                return false;
            }

            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $exception) {
            $this->logger->error(
                'ConversationManagement::truncateConversationFromMessage error',
                ['exception' => $exception]
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
            if ((int)$conversation->getCustomerId() !== $customerId || !$this->matchesCurrentStoreScope($conversation)) {
                return false;
            }

            if ((string)$conversation->getData('conversation_type') === 'support') {
                return $this->closeSupportConversation($conversation);
            }

            $this->deleteConversationRows($conversationId);
            // File cleanup is deliberately post-commit and idempotent. A stale
            // private directory is safer than a partially deleted transcript.
            $this->chatAttachmentStorage->deleteConversationAttachments((int)$customerId, $conversationId);
            return true;
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::deleteConversation error', ['exception' => $e]);
            return false;
        }
    }

    /**
     * @inheritdoc
     */
    public function touchConversation(int $conversationId, int $customerId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();

        try {
            $conversation = $this->getCustomerOwnedConversation($conversationId, $customerId);
            if (!$conversation) {
                return false;
            }
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
            if ((int)$conversation->getCustomerId() !== $customerId || !$this->matchesCurrentStoreScope($conversation)) {
                return false;
            }
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return true;
        } catch (\Exception $e) {
            $this->logger->error('ConversationManagement::updateConversationTitle error', ['exception' => $e]);
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
            $scope = $this->currentStoreScope();
            $conversation->setData('store_id', $scope['store_id']);
            $conversation->setData('website_id', $scope['website_id']);
            $conversation->setTitle(mb_substr($title, 0, 255));
            $this->conversationRepository->save($conversation);
            return (int)$conversation->getConversationId();
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::createGuestConversation error', ['exception' => $exception]);
            throw $exception;
        }
    }

    public function listGuestConversations(string $guestId, int $pageSize = 20, int $currentPage = 1): array
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $scope = $this->currentStoreScope();
        $guestId = $this->normalizeGuestId($guestId);
        $pageSize = max(1, min($pageSize, 20));
        $currentPage = max(1, $currentPage);

        $sortOrder = $this->sortOrderBuilder
            ->setField('updated_at')
            ->setDescendingDirection()
            ->create();
        $criteria = $this->searchCriteriaBuilder
            ->addFilter('guest_id', $guestId)
            ->addFilter('store_id', $scope['store_id'])
            ->addFilter('website_id', $scope['website_id'])
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
        if (!$this->getGuestOwnedConversation($conversationId, $guestId)) {
            return ['messages' => [], 'has_more' => false, 'next_before_message_id' => null];
        }
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
        $scope = $this->currentStoreScope();
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
        if ($role === 'user') {
            $this->attachUserMessage($message, $attachment, $guestId, $conversationId);
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
                'ConversationManagement::truncateGuestConversationFromMessage error',
                ['exception' => $exception]
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
            $this->deleteConversationRows($conversationId);
            $this->chatAttachmentStorage->deleteConversationAttachments($guestId, $conversationId);
            return true;
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::deleteGuestConversation error', ['exception' => $exception]);
            return false;
        }
    }

    public function deleteGuestConversations(string $guestId): bool
    {
        $this->nodeRequestAuthorizer->assertAuthorized();
        $scope = $this->currentStoreScope();
        $guestId = $this->normalizeGuestId($guestId);

        try {
            $conversationIds = $this->conversationResource->getAiConversationIdsForGuest(
                $guestId,
                $scope['store_id'],
                $scope['website_id']
            );

            if ($conversationIds !== []) {
                $this->conversationResource->deleteRowsByIds($conversationIds);
                foreach ($conversationIds as $conversationId) {
                    $this->chatAttachmentStorage->deleteConversationAttachments($guestId, $conversationId);
                }
            }
            return true;
        } catch (\Exception $exception) {
            $this->logger->error('ConversationManagement::deleteGuestConversations error', ['exception' => $exception]);
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
        return $this->conversationResource->truncateMessagesFrom($conversationId, $fromMessageId);
    }

    private function getGuestOwnedConversation(int $conversationId, string $guestId)
    {
        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            $guestId = $this->normalizeGuestId($guestId);
            return hash_equals((string)$conversation->getGuestId(), $guestId)
                && $this->matchesCurrentStoreScope($conversation)
                ? $conversation
                : null;
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

    private function getCustomerOwnedConversation(int $conversationId, int $customerId)
    {
        try {
            $conversation = $this->conversationRepository->getById($conversationId);
            return (int)$conversation->getCustomerId() === $customerId
                && $this->matchesCurrentStoreScope($conversation)
                ? $conversation
                : null;
        } catch (\Throwable) {
            return null;
        }
    }

    private function attachUserMessage(
        MessageInterface $message,
        ?string $attachment,
        int|string $ownerId,
        int $conversationId
    ): void {
        if ($attachment === null || trim($attachment) === '') {
            return;
        }

        $decoded = json_decode($attachment, true);
        if (is_array($decoded)
            && (isset($decoded['attachments'][0]['attachment_id'])
                || isset($decoded['attachments'][0]['url'])
                || isset($decoded['attachment_id']))) {
            $message->setAttachment($attachment);
            return;
        }

        $message->setAttachment(
            $this->chatAttachmentStorage->storeFromJson($attachment, $ownerId, $conversationId)
        );
    }

    private function deleteConversationRows(int $conversationId): void
    {
        $this->conversationResource->deleteRows($conversationId);
    }

    /** @return array{store_id:int,website_id:int} */
    private function currentStoreScope(): array
    {
        $store = $this->storeManager->getStore();
        return [
            'store_id' => (int)$store->getId(),
            'website_id' => (int)$store->getWebsiteId(),
        ];
    }

    private function matchesCurrentStoreScope($conversation): bool
    {
        $scope = $this->currentStoreScope();
        return (int)$conversation->getData('store_id') === $scope['store_id']
            && (int)$conversation->getData('website_id') === $scope['website_id'];
    }

    private function closeSupportConversation($conversation): bool
    {
        $conversationId = (int)$conversation->getConversationId();
        if ($conversationId < 1) {
            return false;
        }

        $connection = $this->conversationResource->getConnection();
        $now = gmdate('Y-m-d H:i:s');
        $connection->beginTransaction();
        try {
            $this->supportCaseResource->closeByConversationId($conversationId, $now);
            $conversation->setData('is_archived', 1);
            $conversation->setData('updated_at', $now);
            $this->conversationRepository->save($conversation);
            $connection->commit();
            return true;
        } catch (\Throwable $exception) {
            $connection->rollBack();
            $this->logger->error(
                'ConversationManagement::closeSupportConversation error',
                ['exception' => $exception]
            );
            return false;
        }
    }
}
