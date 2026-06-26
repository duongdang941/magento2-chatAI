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
        private readonly Filesystem $filesystem
    ) {
    }

    public function execute(): Raw
    {
        /** @var Raw $result */
        $result = $this->resultFactory->create(ResultFactory::TYPE_RAW);
        $conversationId = (int)$this->request->getParam('conversation_id');
        $filename = strtolower(trim((string)$this->request->getParam('file')));
        $extension = pathinfo($filename, PATHINFO_EXTENSION);
        if ($conversationId < 1
            || !preg_match('/^[a-f0-9]{40}\.(?:jpg|png|webp)$/D', $filename)
            || !isset(self::MIME_BY_EXTENSION[$extension])
        ) {
            return $this->notFound($result);
        }

        $customerId = $this->customerSession->isLoggedIn()
            ? (int)$this->customerSession->getCustomerId()
            : null;
        $guestId = $customerId ? null : $this->guestChatIdentity->resolve();
        if (!$this->conversationIdentity->ownsConversation($conversationId, $customerId, $guestId)) {
            return $this->notFound($result);
        }

        $ownerPath = $customerId
            ? (string)$customerId
            : 'guest/' . $guestId;
        $relativeFile = 'afd_ai/chat/' . $ownerPath . '/' . $conversationId . '/' . $filename;
        $directory = $this->filesystem->getDirectoryRead(DirectoryList::VAR_DIR);
        if (!$directory->isFile($relativeFile)) {
            return $this->notFound($result);
        }

        $result->setHeader('Content-Type', self::MIME_BY_EXTENSION[$extension], true);
        $result->setHeader('Content-Disposition', 'inline; filename="' . $filename . '"', true);
        $result->setHeader('Cache-Control', 'private, no-store, max-age=0', true);
        $result->setHeader('X-Content-Type-Options', 'nosniff', true);
        $result->setHeader('X-Frame-Options', 'DENY', true);
        $result->setHeader('Cross-Origin-Resource-Policy', 'same-origin', true);
        $result->setHeader('Referrer-Policy', 'no-referrer', true);
        $result->setContents($directory->readFile($relativeFile));
        return $result;
    }

    private function notFound(Raw $result): Raw
    {
        $result->setHttpResponseCode(404);
        $result->setHeader('Cache-Control', 'no-store', true);
        $result->setContents('');
        return $result;
    }
}
