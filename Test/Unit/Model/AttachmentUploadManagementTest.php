<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model;

use Afd\AI\Api\Data\AttachmentUploadTicketInterface;
use Afd\AI\Api\Data\AttachmentUploadTicketInterfaceFactory;
use Afd\AI\Model\AttachmentUploadManagement;
use Afd\AI\Model\Config\Config as AiConfig;
use Afd\AI\Model\Data\AttachmentUploadTicket;
use Afd\AI\Model\Maintenance\AttachmentDiskGuard;
use Afd\AI\Model\Maintenance\AttachmentQuotaCounter;
use Afd\AI\Model\Security\GuestChatIdentity;
use Magento\Customer\Model\Session as CustomerSession;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem;
use Magento\Framework\Filesystem\Directory\ReadInterface;
use Magento\Framework\UrlInterface;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class AttachmentUploadManagementTest extends TestCase
{
    private AiConfig|MockObject $config;
    private CustomerSession|MockObject $customerSession;
    private GuestChatIdentity|MockObject $guestChatIdentity;
    private AttachmentDiskGuard|MockObject $diskGuard;
    private AttachmentQuotaCounter|MockObject $quotaCounter;
    private AttachmentUploadTicketInterfaceFactory|MockObject $ticketFactory;
    private UrlInterface|MockObject $urlBuilder;
    private ScopeConfigInterface|MockObject $scopeConfig;
    private EncryptorInterface|MockObject $encryptor;
    private Filesystem|MockObject $filesystem;
    private AttachmentUploadManagement $management;

    protected function setUp(): void
    {
        $this->config = $this->createMock(AiConfig::class);
        $this->customerSession = $this->createMock(CustomerSession::class);
        $this->guestChatIdentity = $this->createMock(GuestChatIdentity::class);
        $this->diskGuard = $this->createMock(AttachmentDiskGuard::class);
        $this->quotaCounter = $this->createMock(AttachmentQuotaCounter::class);
        $this->ticketFactory = $this->createMock(AttachmentUploadTicketInterfaceFactory::class);
        $this->urlBuilder = $this->createMock(UrlInterface::class);
        $this->scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $this->encryptor = $this->createMock(EncryptorInterface::class);
        $this->filesystem = $this->createMock(Filesystem::class);

        $this->management = new AttachmentUploadManagement(
            $this->config,
            $this->customerSession,
            $this->guestChatIdentity,
            $this->diskGuard,
            $this->quotaCounter,
            $this->ticketFactory,
            $this->urlBuilder,
            $this->scopeConfig,
            $this->encryptor,
            $this->filesystem
        );
    }

    public function testInitiateReturnsSignedTicketAndReservesQuota(): void
    {
        $this->config->method('isEnabled')->willReturn(true);
        $this->config->method('getAttachmentConfig')->willReturn([
            'min_free_bytes' => 104857600,
            'max_image_bytes' => 4194304,
            'max_owner_storage_bytes' => 67108864,
            'max_total_storage_bytes' => 1073741824,
        ]);
        $this->customerSession->method('getCustomerId')->willReturn(42);
        $this->scopeConfig->method('getValue')->willReturn('test-secret-key-123');

        $this->quotaCounter->expects($this->once())
            ->method('reserve')
            ->with('42', 67108864, 2048, 1073741824);

        $this->urlBuilder->method('getUrl')->willReturn('https://example.com/afd_ai/chat/upload?id=att_123');
        $this->ticketFactory->method('create')->willReturn(new AttachmentUploadTicket());

        $ticket = $this->management->initiate('vision', 2048, 'image/png');

        $this->assertNotEmpty($ticket->getAttachmentId());
        $this->assertStringStartsWith('att_', $ticket->getAttachmentId());
        $this->assertNotEmpty($ticket->getTicket());
        $this->assertContains('image/png', $ticket->getAllowedMimeTypes());
    }

    public function testInitiateRejectsInvalidPurpose(): void
    {
        $this->config->method('isEnabled')->willReturn(true);
        $this->expectException(LocalizedException::class);
        $this->expectExceptionMessage('Invalid attachment upload purpose.');

        $this->management->initiate('unsupported_purpose', 1024, 'image/jpeg');
    }

    public function testCompleteVerifiesTicketAndCommitsQuota(): void
    {
        $this->customerSession->method('getCustomerId')->willReturn(42);
        $this->scopeConfig->method('getValue')->willReturn('test-secret-key-123');

        $writeDir = $this->createMock(\Magento\Framework\Filesystem\Directory\WriteInterface::class);
        $writeDir->method('isFile')->willReturnCallback(function (string $path) {
            return str_ends_with($path, 'att_test123.jpg');
        });
        $writeDir->method('stat')->willReturn(['size' => 5000]);
        $this->filesystem->method('getDirectoryWrite')->willReturn($writeDir);

        $this->quotaCounter->expects($this->once())
            ->method('commit')
            ->with('42', 5000);

        // Craft a valid ticket for att_test123
        $ticketPayload = [
            'aid' => 'att_test123',
            'owner' => hash('sha256', '42'),
            'purpose' => 'vision',
            'max_bytes' => 4194304,
            'reserved_bytes' => 5000,
            'mime' => 'image/jpeg',
            'exp' => time() + 300,
            'nonce' => 'abc12345',
        ];
        $json = json_encode($ticketPayload);
        $b64 = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
        $sig = hash_hmac('sha256', $b64, 'test-secret-key-123', true);
        $sigB64 = rtrim(strtr(base64_encode($sig), '+/', '-_'), '=');
        $validToken = $b64 . '.' . $sigB64;

        $result = $this->management->complete('att_test123', $validToken);
        $this->assertTrue($result);
    }

    public function testCompleteIsIdempotentWhenCalledTwice(): void
    {
        $this->customerSession->method('getCustomerId')->willReturn(42);
        $this->scopeConfig->method('getValue')->willReturn('test-secret-key-123');

        $writeDir = $this->createMock(\Magento\Framework\Filesystem\Directory\WriteInterface::class);
        // First call: meta does not exist, file exists
        // Second call: meta exists with committed state
        $metaExists = false;
        $writeDir->method('isFile')->willReturnCallback(function (string $path) use (&$metaExists) {
            if (str_ends_with($path, '.meta.json')) {
                return $metaExists;
            }
            return str_ends_with($path, 'att_test123.jpg');
        });
        $writeDir->method('stat')->willReturn(['size' => 5000]);
        $writeDir->method('readFile')->willReturnCallback(function () {
            return json_encode(['state' => 'committed', 'attachment_id' => 'att_test123']);
        });
        $writeDir->method('writeFile')->willReturnCallback(function () use (&$metaExists) {
            $metaExists = true;
            return 100;
        });
        $this->filesystem->method('getDirectoryWrite')->willReturn($writeDir);

        // Commit should only be called ONCE across both calls!
        $this->quotaCounter->expects($this->once())
            ->method('commit')
            ->with('42', 5000);

        $ticketPayload = [
            'aid' => 'att_test123',
            'owner' => hash('sha256', '42'),
            'purpose' => 'vision',
            'max_bytes' => 4194304,
            'reserved_bytes' => 5000,
            'mime' => 'image/jpeg',
            'exp' => time() + 300,
            'nonce' => 'abc12345',
        ];
        $json = json_encode($ticketPayload);
        $b64 = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
        $sig = hash_hmac('sha256', $b64, 'test-secret-key-123', true);
        $sigB64 = rtrim(strtr(base64_encode($sig), '+/', '-_'), '=');
        $validToken = $b64 . '.' . $sigB64;

        $firstResult = $this->management->complete('att_test123', $validToken);
        $this->assertTrue($firstResult);

        // Second replay call
        $secondResult = $this->management->complete('att_test123', $validToken);
        $this->assertTrue($secondResult);
    }
}
