<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Knowledge;

use Afd\AI\Model\Knowledge\KnowledgeDocumentRepository;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;

class Delete extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::knowledge';

    public function __construct(
        Context $context,
        private readonly KnowledgeDocumentRepository $knowledgeRepository
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        if (!$this->getRequest()->isPost()) {
            $this->messageManager->addErrorMessage(__('Knowledge documents can only be deleted from a confirmed form submission.'));
            return $this->_redirect('afd_ai/knowledge/index');
        }
        $id = max(0, (int)$this->getRequest()->getParam('id'));
        if ($id < 1) {
            $this->messageManager->addErrorMessage(__('A knowledge document was not selected.'));
            return $this->_redirect('afd_ai/knowledge/index');
        }
        try {
            $this->knowledgeRepository->delete($id);
            $this->messageManager->addSuccessMessage(__('Knowledge document deleted and removed from retrieval.'));
        } catch (\Throwable $error) {
            $this->messageManager->addErrorMessage(__('The knowledge document could not be deleted.'));
        }
        return $this->_redirect('afd_ai/knowledge/index');
    }
}
