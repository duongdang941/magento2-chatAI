<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Adminhtml\Knowledge;

use Afd\AI\Model\Knowledge\KnowledgeDocumentRepository;
use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Store\Model\StoreManagerInterface;

class Save extends Action
{
    public const ADMIN_RESOURCE = 'Afd_AI::knowledge';
    private const STATUSES = ['draft', 'review', 'published', 'archived'];

    public function __construct(
        Context $context,
        private readonly KnowledgeDocumentRepository $knowledgeRepository,
        private readonly StoreManagerInterface $storeManager
    ) {
        parent::__construct($context);
    }

    public function execute()
    {
        $request = $this->getRequest();
        $id = max(0, (int)$request->getParam('entity_id'));
        $title = mb_substr(trim((string)$request->getParam('title')), 0, 255);
        $identifier = strtolower(mb_substr(trim((string)$request->getParam('identifier')), 0, 128));
        $content = trim((string)$request->getParam('content'));
        $sourceUrl = trim((string)$request->getParam('source_url'));
        $language = preg_replace('/[^A-Za-z0-9-]/', '', (string)$request->getParam('language')) ?: '';
        $status = strtolower(trim((string)$request->getParam('status')));
        $storeId = max(0, (int)$request->getParam('store_id'));
        $groupId = max(0, (int)$request->getParam('customer_group_id'));
        $effectiveAt = $this->dateValue($request->getParam('effective_at'));
        $expiresAt = $this->dateValue($request->getParam('expires_at'));

        if ($title === '' || $identifier === '' || $content === '') {
            $this->messageManager->addErrorMessage(__('Title, identifier and content are required.'));
            return $this->redirectBack($id);
        }
        if (!preg_match('/^[a-z0-9][a-z0-9._-]{0,127}$/', $identifier)) {
            $this->messageManager->addErrorMessage(__('Identifier may contain only lowercase letters, numbers, dots, underscores and hyphens.'));
            return $this->redirectBack($id);
        }
        if ($sourceUrl !== '') {
            $parsed = parse_url($sourceUrl);
            if (!is_array($parsed) || !in_array(strtolower((string)($parsed['scheme'] ?? '')), ['http', 'https'], true)) {
                $this->messageManager->addErrorMessage(__('Source URL must use HTTP or HTTPS.'));
                return $this->redirectBack($id);
            }
            $sourceUrl = mb_substr($sourceUrl, 0, 1024);
        }
        if (!in_array($status, self::STATUSES, true)) $status = 'draft';
        if ($expiresAt !== null && $effectiveAt !== null && $expiresAt <= $effectiveAt) {
            $this->messageManager->addErrorMessage(__('Expiry must be later than the effective date.'));
            return $this->redirectBack($id);
        }

        $websiteId = 0;
        if ($storeId > 0) {
            try {
                $websiteId = (int)$this->storeManager->getStore($storeId)->getWebsiteId();
            } catch (\Throwable) {
                $this->messageManager->addErrorMessage(__('The selected store view does not exist.'));
                return $this->redirectBack($id);
            }
        }

        $now = gmdate('Y-m-d H:i:s');
        $adminId = (int)($this->_auth->getUser()->getId() ?: 0);
        try {
            if ($id > 0) {
                $old = $this->knowledgeRepository->getById($id);
                if ($old === null) {
                    throw new \RuntimeException('Document not found.');
                }
                $version = (int)($old['version'] ?? 1);
                if ((string)($old['content'] ?? '') !== $content || (string)($old['status'] ?? '') !== $status) {
                    $version++;
                }
            } else {
                $version = 1;
            }

            $data = [
                'title' => $title, 'identifier' => $identifier, 'content' => $content,
                'source_url' => $sourceUrl !== '' ? $sourceUrl : null, 'language' => $language,
                'status' => $status, 'store_id' => $storeId, 'website_id' => $websiteId,
                'customer_group_id' => $groupId > 0 ? $groupId : null, 'version' => $version,
                'effective_at' => $effectiveAt, 'expires_at' => $expiresAt,
                'updated_by' => $adminId, 'updated_at' => $now,
            ];
            if ($id < 1) {
                $data['created_by'] = $adminId;
                $data['created_at'] = $now;
            }
            $this->knowledgeRepository->save($id, $data);
            $this->messageManager->addSuccessMessage(__('Knowledge document saved.'));
        } catch (\Throwable $error) {
            $this->messageManager->addErrorMessage(__('The knowledge document could not be saved: %1', $error->getMessage()));
        }
        return $this->_redirect('afd_ai/knowledge/index');
    }

    private function redirectBack(int $id)
    {
        return $this->_redirect('afd_ai/knowledge/index', $id > 0 ? ['id' => $id] : []);
    }

    private function dateValue(mixed $value): ?string
    {
        $value = trim((string)$value);
        if ($value === '') return null;
        $time = strtotime($value);
        return $time === false ? null : gmdate('Y-m-d H:i:s', $time);
    }
}
