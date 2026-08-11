<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\Data\MessageInterface;
use Magento\Framework\Model\AbstractModel;

class Message extends AbstractModel implements MessageInterface
{
    protected function _construct()
    {
        $this->_init(\Afd\AI\Model\ResourceModel\Message::class);
    }

    public function getEntityId()
    {
        return $this->getData(self::ENTITY_ID);
    }

    public function setEntityId($entityId)
    {
        return $this->setData(self::ENTITY_ID, $entityId);
    }

    public function getSessionId()
    {
        return $this->getData(self::SESSION_ID);
    }

    public function setSessionId($sessionId)
    {
        return $this->setData(self::SESSION_ID, $sessionId);
    }

    public function getCustomerId()
    {
        return $this->getData(self::CUSTOMER_ID);
    }

    public function setCustomerId($customerId)
    {
        return $this->setData(self::CUSTOMER_ID, $customerId);
    }

    public function getConversationId()
    {
        return $this->getData(self::CONVERSATION_ID);
    }

    public function setConversationId($conversationId)
    {
        return $this->setData(self::CONVERSATION_ID, $conversationId);
    }

    public function getRole()
    {
        return $this->getData(self::ROLE);
    }

    public function setRole($role)
    {
        return $this->setData(self::ROLE, $role);
    }

    public function getContent()
    {
        return $this->getData(self::CONTENT);
    }

    public function setContent($content)
    {
        return $this->setData(self::CONTENT, $content);
    }

    public function getAttachment()
    {
        return $this->getData(self::ATTACHMENT);
    }

    public function setAttachment($attachment)
    {
        return $this->setData(self::ATTACHMENT, $attachment);
    }

    public function getCreatedAt()
    {
        return $this->getData(self::CREATED_AT);
    }
}
