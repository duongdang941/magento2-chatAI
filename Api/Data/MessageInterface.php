<?php
declare(strict_types=1);

namespace Afd\AI\Api\Data;

interface MessageInterface
{
    const ENTITY_ID = 'entity_id';
    const SESSION_ID = 'session_id';
    const CUSTOMER_ID = 'customer_id';
    const CONVERSATION_ID = 'conversation_id';
    const ROLE = 'role';
    const CONTENT = 'content';
    const ATTACHMENT = 'attachment';
    const CREATED_AT = 'created_at';

    /**
     * @return int|null
     */
    public function getEntityId();

    /**
     * @param int $entityId
     * @return $this
     */
    public function setEntityId($entityId);

    /**
     * @return string
     */
    public function getSessionId();

    /**
     * @param string $sessionId
     * @return $this
     */
    public function setSessionId($sessionId);

    /**
     * @return int|null
     */
    public function getCustomerId();

    /**
     * @param int|null $customerId
     * @return $this
     */
    public function setCustomerId($customerId);

    /**
     * @return int|null
     */
    public function getConversationId();

    /**
     * @param int|null $conversationId
     * @return $this
     */
    public function setConversationId($conversationId);

    /**
     * @return string
     */
    public function getRole();

    /**
     * @param string $role
     * @return $this
     */
    public function setRole($role);

    /**
     * @return string
     */
    public function getContent();

    /**
     * @param string $content
     * @return $this
     */
    public function setContent($content);

    /**
     * JSON metadata for a persisted user attachment. Image bytes are stored in media, never here.
     *
     * @return string|null
     */
    public function getAttachment();

    /**
     * @param string|null $attachment
     * @return $this
     */
    public function setAttachment($attachment);

    /**
     * @return string
     */
    public function getCreatedAt();
}
