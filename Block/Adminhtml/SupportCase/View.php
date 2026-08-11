<?php
declare(strict_types=1);

namespace Afd\AI\Block\Adminhtml\SupportCase;

use Afd\AI\Model\SupportCase;
use Afd\AI\Model\Support\SupportTranscriptService;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Backend\Block\Template;
use Magento\Backend\Block\Template\Context;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Registry;

class View extends Template
{
    public function __construct(
        Context $context,
        private readonly Registry $registry,
        private readonly EncryptorInterface $encryptor,
        private readonly SupportTranscriptService $transcriptService,
        private readonly SupportInboxService $inboxService,
        array $data = []
    ) {
        parent::__construct($context, $data);
    }

    public function getCase(): SupportCase
    {
        return $this->registry->registry('afd_ai_support_case');
    }

    public function getContactEmail(): string
    {
        $encrypted = (string)$this->getCase()->getData('contact_email');
        if ($encrypted === '') return '';
        try {
            return $this->encryptor->decrypt($encrypted);
        } catch (\Throwable) {
            return '';
        }
    }

    public function canReply(): bool
    {
        return !in_array((string)$this->getCase()->getData('status'), ['resolved', 'closed'], true);
    }

    public function getReplyUrl(): string
    {
        return $this->getUrl('afd_ai/supportcase/reply');
    }

    public function getMessagesUrl(): string { return $this->getUrl('afd_ai/supportcase/messages'); }
    public function getMarkReadUrl(): string { return $this->getUrl('afd_ai/supportcase/markRead'); }

    /** @return array<int, array<string, mixed>> */
    public function getTickets(): array
    {
        return $this->inboxService->getTicketsForCase($this->getCase()->getData());
    }

    /** @return array<int, array{role:string,text:string,created_at:string,source:string,sender_label:string}> */
    public function getTranscript(): array
    {
        return $this->transcriptService->load((int)$this->getCase()->getData('conversation_id'));
    }
}
