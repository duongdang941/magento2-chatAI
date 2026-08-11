<?php
declare(strict_types=1);
namespace Afd\AI\Controller\Adminhtml\Supportcase;

use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\SupportCaseFactory;
use Afd\AI\Model\Support\SupportTranscriptService;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;

class Messages extends Action implements HttpGetActionInterface
{
    public const ADMIN_RESOURCE = 'Afd_AI::support_cases';
    public function __construct(
        Context $context,
        private readonly SupportCaseFactory $caseFactory,
        private readonly SupportCaseResource $caseResource,
        private readonly SupportTranscriptService $transcriptService,
        private readonly SupportInboxService $inboxService
    ) { parent::__construct($context); }
    public function execute(): Json
    {
        /** @var Json $result */ $result = $this->resultFactory->create(ResultFactory::TYPE_JSON);
        $case = $this->caseFactory->create();
        $this->caseResource->load($case, (int)$this->getRequest()->getParam('entity_id'));
        if (!$case->getId()) return $result->setHttpResponseCode(404)->setData(['status' => 'error']);
        $messages = $this->transcriptService->load(
            (int)$case->getData('conversation_id'),
            max(0, (int)$this->getRequest()->getParam('after_id')),
            100,
            (int)$this->_auth->getUser()->getId()
        );
        if (in_array((string)$case->getData('status'), ['resolved', 'closed'], true)) {
            $messages = array_map(static function (array $message): array {
                $message['can_mutate'] = false;
                return $message;
            }, $messages);
        }
        $tickets = array_map(static fn (array $ticket): array => [
            'entity_id' => (int)($ticket['entity_id'] ?? 0),
            'conversation_id' => (int)($ticket['conversation_id'] ?? 0),
            'public_id' => (string)($ticket['public_id'] ?? ''),
            'subject' => (string)($ticket['subject'] ?? ''),
            'status' => (string)($ticket['status'] ?? 'open'),
            'priority' => (string)($ticket['priority'] ?? 'normal'),
            'category' => (string)($ticket['category'] ?? 'general'),
            'admin_unread_count' => (int)($ticket['admin_unread_count'] ?? 0),
            'updated_at' => (string)($ticket['updated_at'] ?? ''),
        ], $this->inboxService->getTicketsForCase($case->getData()));
        return $result->setData([
            'status' => 'success',
            'messages' => $messages,
            'tickets' => $tickets,
            'case' => [
                'entity_id' => (int)$case->getId(),
                'conversation_id' => (int)$case->getData('conversation_id'),
                'public_id' => (string)$case->getData('public_id'),
                'subject' => (string)$case->getData('subject'),
                'summary' => (string)$case->getData('summary'),
                'status' => (string)$case->getData('status'),
                'priority' => (string)$case->getData('priority'),
                'category' => (string)$case->getData('category'),
                'contact_email' => $this->inboxService->decryptEmail((string)$case->getData('contact_email')),
                'can_reply' => !in_array((string)$case->getData('status'), ['resolved', 'closed'], true),
            ],
        ]);
    }
}
