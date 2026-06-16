<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

interface ConversationInterface
{
    const CONVERSATION_ID = 'conversation_id';
    const CUSTOMER_ID = 'customer_id';
    const GUEST_ID = 'guest_id';
    const TITLE = 'title';
    const CREATED_AT = 'created_at';
    const UPDATED_AT = 'updated_at';

    /**
     * @return int|null
     */
    public function getConversationId();

    /**
     * @param int $conversationId
     * @return $this
     */
    public function setConversationId($conversationId);

    /**
     * @return int|null
     */
    public function getCustomerId();

    /**
     * @param int|null $customerId
     * @return $this
     */
    public function setCustomerId($customerId);

    /** @return string|null */
    public function getGuestId();

    /** @param string|null $guestId @return $this */
    public function setGuestId($guestId);

    /**
     * @return string
     */
    public function getTitle();

    /**
     * @param string $title
     * @return $this
     */
    public function setTitle($title);

    /**
     * @return string
     */
    public function getCreatedAt();

    /**
     * @return string
     */
    public function getUpdatedAt();
}
