<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Controller\Chat;

use Afd\AI\Controller\Chat\Attachment;
use Afd\AI\Model\Conversation\ConversationIdentity;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\RequestInterface;
use Magento\Framework\Controller\Result\Raw;
use Magento\Framework\Controller\ResultFactory;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\ReadInterface;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class AttachmentTest extends TestCase
{
    private RequestInterface|MockObject $request;
    private ResultFactory|MockObject $resultFactory;
    private CustomerSession|MockObject $customerSession;
    private GuestChatIdentity|MockObject $guestChatIdentity;
    private ConversationIdentity|MockObject $conversationIdentity;
    private Filesystem|MockObject $filesystem;
    private \Magento\Framework\App\Response\Http\FileFactory|MockObject $fileFactory;
    private Attachment $controller;

    protected function setUp(): void
    {
        $this->request = $this->createMock(RequestInterface::class);
        $this->resultFactory = $this->createMock(ResultFactory::class);
        $this->customerSession = $this->createMock(CustomerSession::class);
        $this->guestChatIdentity = $this->createMock(GuestChatIdentity::class);
        $this->conversationIdentity = $this->createMock(ConversationIdentity::class);
        $this->filesystem = $this->createMock(Filesystem::class);
        $this->fileFactory = $this->createMock(\Magento\Framework\App\Response\Http\FileFactory::class);

        $this->controller = new Attachment(
            $this->request,
            $this->resultFactory,
            $this->customerSession,
            $this->guestChatIdentity,
            $this->conversationIdentity,
            $this->filesystem,
            $this->fileFactory
        );
    }

    public function testExecuteServesFileByAttachmentId(): void
    {
        $this->request->method('getParam')->willReturnCallback(function (string $param) {
            return match ($param) {
                'id', 'attachment_id' => 'att_0123456789abcdef0123456789abcdef',
                default => null,
            };
        });

        $this->customerSession->method('isLoggedIn')->willReturn(true);
        $this->customerSession->method('getCustomerId')->willReturn(42);

        $readDir = $this->createMock(ReadInterface::class);
        $readDir->method('isFile')->willReturnCallback(function (string $path) {
            return str_ends_with($path, 'att_0123456789abcdef0123456789abcdef.png');
        });
        $this->filesystem->method('getDirectoryRead')->willReturn($readDir);

        $mockResponse = $this->createMock(\Magento\Framework\App\ResponseInterface::class);
        $this->fileFactory->expects($this->once())
            ->method('create')
            ->with(
                'att_0123456789abcdef0123456789abcdef.png',
                $this->callback(fn($val) => ($val['type'] ?? '') === 'filename'),
                \Magento\Framework\App\Filesystem\DirectoryList::VAR_DIR,
                'image/png'
            )
            ->willReturn($mockResponse);

        $result = $this->controller->execute();
        $this->assertSame($mockResponse, $result);
    }

    public function testExecuteServesFileByConversationAndFilename(): void
    {
        $filename = 'abcdef0123456789abcdef0123456789abcdef01.jpg';
        $this->request->method('getParam')->willReturnCallback(function (string $param) use ($filename) {
            return match ($param) {
                'conversation_id' => 10,
                'file' => $filename,
                default => null,
            };
        });

        $this->customerSession->method('isLoggedIn')->willReturn(true);
        $this->customerSession->method('getCustomerId')->willReturn(42);
        $this->conversationIdentity->method('ownsConversation')->with(10, 42, null)->willReturn(true);

        $readDir = $this->createMock(ReadInterface::class);
        $readDir->method('isFile')->willReturn(true);
        $this->filesystem->method('getDirectoryRead')->willReturn($readDir);

        $mockResponse = $this->createMock(\Magento\Framework\App\ResponseInterface::class);
        $this->fileFactory->expects($this->once())
            ->method('create')
            ->with(
                $filename,
                $this->callback(fn($val) => ($val['type'] ?? '') === 'filename'),
                \Magento\Framework\App\Filesystem\DirectoryList::VAR_DIR,
                'image/jpeg'
            )
            ->willReturn($mockResponse);

        $result = $this->controller->execute();
        $this->assertSame($mockResponse, $result);
    }

    public function testExecuteReturns404WhenUnownedConversation(): void
    {
        $filename = 'abcdef0123456789abcdef0123456789abcdef01.jpg';
        $this->request->method('getParam')->willReturnCallback(function (string $param) use ($filename) {
            return match ($param) {
                'conversation_id' => 10,
                'file' => $filename,
                default => null,
            };
        });

        $this->customerSession->method('isLoggedIn')->willReturn(true);
        $this->customerSession->method('getCustomerId')->willReturn(42);
        $this->conversationIdentity->method('ownsConversation')->with(10, 42, null)->willReturn(false);

        $rawResult = $this->createMock(Raw::class);
        $rawResult->expects($this->once())->method('setHttpResponseCode')->with(404)->willReturnSelf();
        $this->resultFactory->method('create')->with(ResultFactory::TYPE_RAW)->willReturn($rawResult);

        $result = $this->controller->execute();
        $this->assertSame($rawResult, $result);
    }

    public function testExecuteSetsCorrectMimeTypesForJpgPngWebp(): void
    {
        foreach ([
            'jpg' => 'image/jpeg',
            'png' => 'image/png',
            'webp' => 'image/webp',
        ] as $ext => $expectedMime) {
            $attachmentId = 'att_0123456789abcdef0123456789abcdef';
            $request = $this->createMock(RequestInterface::class);
            $request->method('getParam')->willReturnCallback(function (string $param) use ($attachmentId) {
                return match ($param) {
                    'id', 'attachment_id' => $attachmentId,
                    default => null,
                };
            });

            $customerSession = $this->createMock(CustomerSession::class);
            $customerSession->method('isLoggedIn')->willReturn(true);
            $customerSession->method('getCustomerId')->willReturn(1);

            $readDir = $this->createMock(ReadInterface::class);
            $readDir->method('isFile')->willReturnCallback(fn(string $p) => str_ends_with($p, '.' . $ext));
            $filesystem = $this->createMock(Filesystem::class);
            $filesystem->method('getDirectoryRead')->willReturn($readDir);

            $mockResponse = $this->createMock(\Magento\Framework\App\ResponseInterface::class);
            $fileFactory = $this->createMock(\Magento\Framework\App\Response\Http\FileFactory::class);
            $fileFactory->expects($this->once())
                ->method('create')
                ->with(
                    $attachmentId . '.' . $ext,
                    $this->anything(),
                    \Magento\Framework\App\Filesystem\DirectoryList::VAR_DIR,
                    $expectedMime
                )
                ->willReturn($mockResponse);

            $resultFactory = $this->createMock(ResultFactory::class);

            $controller = new Attachment(
                $request,
                $resultFactory,
                $customerSession,
                $this->guestChatIdentity,
                $this->conversationIdentity,
                $filesystem,
                $fileFactory
            );

            $result = $controller->execute();
            $this->assertSame($mockResponse, $result);
        }
    }
}
