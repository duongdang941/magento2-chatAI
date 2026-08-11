<?php
declare(strict_types=1);

namespace Afd\AI\Api;

/**
 * REST API for Node.js chat server to manage conversations and messages.
 * All DB logic stays in Magento module.
 */
interface ConversationManagementInterface
{
    /**
     * Authenticated liveness check used by the Node gateway.
     *
     * @return bool
     */
    public function healthCheck(): bool;

    /**
     * Create a new conversation for a customer
     *
     * @param int $customerId
     * @param string $title
     * @return int Conversation ID
     */
    public function createConversation(int $customerId, string $title): int;

    /**
     * Return one bounded page of a customer's conversations, newest first.
     *
     * @param int $customerId
     * @param int $pageSize
     * @param int $currentPage
     * @return mixed[] [items, has_more, next_page]
     */
    public function listConversations(
        int $customerId,
        int $pageSize = 20,
        int $currentPage = 1
    ): array;

    /**
     * Resolve one conversation after verifying that it belongs to the customer.
     *
     * @param int $conversationId
     * @param int $customerId
     * @return mixed[] Empty when it does not exist or belongs to another customer.
     */
    public function getConversation(int $conversationId, int $customerId): array;

    /**
     * Load messages for a conversation (with ownership check)
     *
     * @param int $conversationId
     * @param int $customerId
     * @param int|null $beforeMessageId Return messages older than this ID when supplied.
     * @param int $pageSize Requested page size, capped by the implementation.
     * @return mixed[] Page data with messages and the cursor for the next page.
     */
    public function loadMessages(
        int $conversationId,
        int $customerId,
        ?int $beforeMessageId = null,
        int $pageSize = 50
    ): array;

    /**
     * Save a message to a conversation
     *
     * @param int $conversationId
     * @param int $customerId
     * @param string $role
     * @param string $content
     * @param string|null $attachment JSON image upload payload from the trusted Node service.
     * @return int Message ID
     */
    public function saveMessage(
        int $conversationId,
        int $customerId,
        string $role,
        string $content,
        ?string $attachment = null
    ): int;

    /**
     * Remove a customer-authored message and every later message in its
     * conversation before an edit or regeneration creates a replacement.
     *
     * @return bool
     */
    public function truncateConversationFromMessage(
        int $conversationId,
        int $customerId,
        int $fromMessageId
    ): bool;

    /**
     * Delete a conversation and its messages (with ownership check)
     *
     * @param int $conversationId
     * @param int $customerId
     * @return bool
     */
    public function deleteConversation(int $conversationId, int $customerId): bool;

    /**
     * Touch (update timestamp) a conversation
     *
     * @param int $conversationId
     * @return bool
     */
    public function touchConversation(int $conversationId): bool;

    /**
     * Update conversation title
     *
     * @param int $conversationId
     * @param int $customerId
     * @param string $title
     * @return bool
     */
    public function updateConversationTitle(int $conversationId, int $customerId, string $title): bool;

    /**
     * Guest conversation methods are callable only by the internally authenticated
     * Node gateway. `$guestId` is a SHA-256 session digest, never a browser-supplied ID.
     * @return int
     */
    public function createGuestConversation(string $guestId, string $title): int;

    /** @return mixed[] [items, has_more, next_page] */
    public function listGuestConversations(string $guestId, int $pageSize = 20, int $currentPage = 1): array;

    /** @return mixed[] */
    public function getGuestConversation(int $conversationId, string $guestId): array;

    /** @return mixed[] */
    public function loadGuestMessages(
        int $conversationId,
        string $guestId,
        ?int $beforeMessageId = null,
        int $pageSize = 50
    ): array;

    /** @return int */
    public function saveGuestMessage(
        int $conversationId,
        string $guestId,
        string $role,
        string $content,
        ?string $attachment = null
    ): int;

    /**
     * Remove a guest-authored message and every later message in its conversation.
     *
     * @return bool
     */
    public function truncateGuestConversationFromMessage(
        int $conversationId,
        string $guestId,
        int $fromMessageId
    ): bool;

    /** @return bool */
    public function deleteGuestConversation(int $conversationId, string $guestId): bool;

    /** @return bool */
    public function deleteGuestConversations(string $guestId): bool;

    /** @return bool */
    public function touchGuestConversation(int $conversationId, string $guestId): bool;

    /** @return bool */
    public function updateGuestConversationTitle(int $conversationId, string $guestId, string $title): bool;
}
