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
    private Attachment $controller;

    protected function setUp(): void
    {
        $this->request = $this->createMock(RequestInterface::class);
        $this->resultFactory = $this->createMock(ResultFactory::class);
        $this->customerSession = $this->createMock(CustomerSession::class);
        $this->guestChatIdentity = $this->createMock(GuestChatIdentity::class);
        $this->conversationIdentity = $this->createMock(ConversationIdentity::class);
        $this->filesystem = $this->createMock(Filesystem::class);

        $this->controller = new Attachment(
            $this->request,
            $this->resultFactory,
            $this->customerSession,
            $this->guestChatIdentity,
            $this->conversationIdentity,
            $this->filesystem
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
        $readDir->method('stat')->willReturn(['size' => 1024]);
        $readDir->method('getAbsolutePath')->willReturn(__FILE__);
        $this->filesystem->method('getDirectoryRead')->willReturn($readDir);

        $rawResult = $this->createMock(Raw::class);
        $rawResult->expects($this->atLeastOnce())->method('setHeader')->willReturnSelf();
        $rawResult->expects($this->once())->method('setContents')->willReturnSelf();
        $this->resultFactory->method('create')->with(ResultFactory::TYPE_RAW)->willReturn($rawResult);

        $result = $this->controller->execute();
        $this->assertSame($rawResult, $result);
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
        $readDir->method('stat')->willReturn(['size' => 2048]);
        $readDir->method('getAbsolutePath')->willReturn(__FILE__);
        $this->filesystem->method('getDirectoryRead')->willReturn($readDir);

        $rawResult = $this->createMock(Raw::class);
        $rawResult->expects($this->atLeastOnce())->method('setHeader')->willReturnSelf();
        $rawResult->expects($this->once())->method('setContents')->willReturnSelf();
        $this->resultFactory->method('create')->with(ResultFactory::TYPE_RAW)->willReturn($rawResult);

        $result = $this->controller->execute();
        $this->assertSame($rawResult, $result);
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
            $readDir->method('stat')->willReturn(['size' => 512]);
            $readDir->method('getAbsolutePath')->willReturn(__FILE__);
            $filesystem = $this->createMock(Filesystem::class);
            $filesystem->method('getDirectoryRead')->willReturn($readDir);

            $rawResult = $this->createMock(Raw::class);
            $setHeaders = [];
            $rawResult->method('setHeader')->willReturnCallback(function ($name, $value) use (&$setHeaders, $rawResult) {
                $setHeaders[$name] = $value;
                return $rawResult;
            });
            $rawResult->method('setContents')->willReturnSelf();

            $resultFactory = $this->createMock(ResultFactory::class);
            $resultFactory->method('create')->with(ResultFactory::TYPE_RAW)->willReturn($rawResult);

            $controller = new Attachment(
                $request,
                $resultFactory,
                $customerSession,
                $this->guestChatIdentity,
                $this->conversationIdentity,
                $filesystem
            );

            $controller->execute();
            $this->assertSame($expectedMime, $setHeaders['Content-Type'] ?? null, "MIME type mismatch for {$ext}");
        }
    }
}
