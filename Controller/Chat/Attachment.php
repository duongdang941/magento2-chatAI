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
        private readonly ?\Magento\Framework\App\Response\Http\FileFactory $fileFactory = null
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
            $stagedDir = 'afd_ai/chat/' . $ownerPath . '/staged';
            foreach (['jpg', 'png', 'webp'] as $ext) {
                $checkPath = $stagedDir . '/' . $attachmentId . '.' . $ext;
                if ($directory->isFile($checkPath)) {
                    $relativeFile = $checkPath;
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

        if (!$relativeFile || !$extension || !isset(self::MIME_BY_EXTENSION[$extension])) {
            return $this->notFound();
        }

        $stat = $directory->stat($relativeFile);
        $fileSize = (int)($stat['size'] ?? 0);
        $absolutePath = $directory->getAbsolutePath($relativeFile);

        if ($this->fileFactory !== null) {
            return $this->fileFactory->create(
                basename($relativeFile),
                [
                    'type' => 'filename',
                    'value' => $relativeFile
                ],
                DirectoryList::VAR_DIR,
                self::MIME_BY_EXTENSION[$extension]
            );
        }

        /** @var Raw $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_RAW);
        $result->setHeader('Content-Type', self::MIME_BY_EXTENSION[$extension], true);
        $result->setHeader('Content-Length', (string)$fileSize, true);
        $result->setHeader('Content-Disposition', 'inline; filename="' . basename($relativeFile) . '"', true);
        $result->setHeader('Cache-Control', 'private, no-store, max-age=0', true);
        $result->setHeader('X-Content-Type-Options', 'nosniff', true);
        $result->setHeader('X-Frame-Options', 'DENY', true);
        $result->setHeader('Cross-Origin-Resource-Policy', 'same-origin', true);
        $result->setHeader('Referrer-Policy', 'no-referrer', true);

        $stream = fopen($absolutePath, 'rb');
        if ($stream) {
            $result->setContents(stream_get_contents($stream));
            fclose($stream);
        } else {
            $result->setContents($directory->readFile($relativeFile));
        }
        return $result;
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
