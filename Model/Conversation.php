<?php
declare(strict_types=1);

namespace Afd\AI\Model;

use Afd\AI\Api\Data\ConversationInterface;
use Magento\Framework\Model\AbstractModel;

class Conversation extends AbstractModel implements ConversationInterface
{
    protected function _construct()
    {
        $this->_init(\Afd\AI\Model\ResourceModel\Conversation::class);
    }

    public function getConversationId()
    {
        return $this->getData(self::CONVERSATION_ID);
    }

    public function setConversationId($conversationId)
    {
        return $this->setData(self::CONVERSATION_ID, $conversationId);
    }

    public function getCustomerId()
    {
        return $this->getData(self::CUSTOMER_ID);
    }

    public function setCustomerId($customerId)
    {
        return $this->setData(self::CUSTOMER_ID, $customerId);
    }

    public function getGuestId()
    {
        return $this->getData(self::GUEST_ID);
    }

    public function setGuestId($guestId)
    {
        return $this->setData(self::GUEST_ID, $guestId);
    }

    public function getTitle()
    {
        return $this->getData(self::TITLE);
    }

    public function setTitle($title)
    {
        return $this->setData(self::TITLE, $title);
    }

    public function getCreatedAt()
    {
        return $this->getData(self::CREATED_AT);
    }

    public function getUpdatedAt()
    {
        return $this->getData(self::UPDATED_AT);
    }
}
