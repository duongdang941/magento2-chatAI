<?php
declare(strict_types=1);

namespace Afd\AI\Controller\Chat;

use Afd\AI\Model\Conversation\ConversationIdentity;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Action\HttpGetActionInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Controller\Result\Raw;
use Magento\Framework\Filesystem;

/** Serves a private chat attachment only to its conversation owner. */
class Attachment implements HttpGetActionInterface
{
    private const MIME_BY_EXTENSION = [
        'jpg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
    ];

    public function __construct(
        private readonly RequestInterface $request,
        private readonly ResultFactory $resultFactory,
        private readonly CustomerSession $customerSession,
        private readonly GuestChatIdentity $guestChatIdentity,
        private readonly ConversationIdentity $conversationIdentity,
        private readonly Filesystem $filesystem,
        private readonly \Magento\Framework\App\Response\Http\FileFactory $fileFactory,
        private readonly ?\Afd\AI\Model\Attachment\AttachmentRepository $attachmentRepository = null
    ) {
    }

    public function execute()
    {
        $conversationId = (int)$this->request->getParam('conversation_id');
        $filename = strtolower(trim((string)$this->request->getParam('file')));
        $attachmentId = strtolower(trim((string)($this->request->getParam('id') ?? $this->request->getParam('attachment_id') ?? '')));

        $customerId = $this->customerSession->isLoggedIn()
            ? (int)$this->customerSession->getCustomerId()
            : null;
        $guestId = $customerId ? null : $this->guestChatIdentity->resolve();

        $ownerPath = $customerId
            ? (string)$customerId
            : 'guest/' . ($guestId ?: hash('sha256', (string)($this->customerSession->getSessionId() ?: 'guest')));

        $directory = $this->filesystem->getDirectoryRead(DirectoryList::VAR_DIR);
        $relativeFile = null;
        $extension = null;

        if ($attachmentId !== '' && preg_match('/^att_[a-f0-9]{32}$/', $attachmentId)) {
            $finalDir = 'afd_ai/chat/' . $ownerPath . '/final';
            $record = $this->attachmentRepository?->getAttachment($attachmentId);
            $recordOwner = hash('sha256', (string)$this->resolveOwnerId($customerId, $guestId));
            $recordPath = (string)($record['final_path'] ?? '');

            if ($this->attachmentRepository && (!$record
                || ($record['state'] ?? '') !== 'committed'
                || (string)($record['owner_key'] ?? '') !== $recordOwner
                || !str_starts_with($recordPath, $finalDir . '/')
            )) {
                return $this->notFound();
            }

            foreach (['jpg', 'png', 'webp'] as $ext) {
                $checkFinal = $finalDir . '/' . $attachmentId . '.' . $ext;
                if ($directory->isFile($checkFinal)
                    && (!$this->attachmentRepository || $recordPath === $checkFinal)
                ) {
                    $relativeFile = $checkFinal;
                    $extension = $ext;
                    break;
                }
            }
        } elseif ($conversationId > 0 && preg_match('/^[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $filename)) {
            if (!$this->conversationIdentity->ownsConversation($conversationId, $customerId, $guestId)) {
                return $this->notFound();
            }
            $checkPath = 'afd_ai/chat/' . $ownerPath . '/' . $conversationId . '/' . $filename;
            if ($directory->isFile($checkPath)) {
                $relativeFile = $checkPath;
                $extension = pathinfo($filename, PATHINFO_EXTENSION);
            }
        }

        $extension = strtolower(trim((string)$extension));
        if (!$relativeFile || !isset(self::MIME_BY_EXTENSION[$extension])) {
            return $this->notFound();
        }

        $mimeType = self::MIME_BY_EXTENSION[$extension];

        return $this->fileFactory->create(
            basename($relativeFile),
            [
                'type' => 'filename',
                'value' => $relativeFile
            ],
            DirectoryList::VAR_DIR,
            $mimeType
        );
    }

    private function resolveOwnerId(?int $customerId, ?string $guestId): string|int
    {
        if ($customerId && $customerId > 0) {
            return $customerId;
        }

        if ($guestId !== null && preg_match('/^[a-f0-9]{32,64}$/i', $guestId)) {
            return $guestId;
        }

        return hash('sha256', (string)($this->customerSession->getSessionId() ?: 'guest'));
    }

    private function notFound(): Raw
    {
        /** @var Raw $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_RAW);
        $result->setHttpResponseCode(404);
        $result->setHeader('Cache-Control', 'no-store', true);
        $result->setContents('');
        return $result;
    }
}
