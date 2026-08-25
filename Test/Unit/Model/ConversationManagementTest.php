<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model;

use Afd\AI\Api\ConversationRepositoryInterface;
use Afd\AI\Api\Data\ConversationInterfaceFactory;
use Afd\AI\Api\Data\MessageInterface;
use Afd\AI\Api\Data\MessageInterfaceFactory;
use Afd\AI\Api\MessageRepositoryInterface;
use Afd\AI\Model\ChatAttachmentStorage;
use Afd\AI\Model\Conversation;
use Afd\AI\Model\Conversation\MessagePageLoader;
use Afd\AI\Model\ConversationManagement;
use Afd\AI\Model\Maintenance\GeneratedImageReferenceRepository;
use Afd\AI\Model\ResourceModel\Conversation as ConversationResource;
use Afd\AI\Model\ResourceModel\SupportCase as SupportCaseResource;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Support\SupportInboxService;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\StoreManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class ConversationManagementTest extends TestCase
{
    public function testSaveMessageCommitsTheCompleteWriteChain(): void
    {
        $harness = $this->createHarness();

        $message = $this->createMock(MessageInterface::class);
        $message->method('getEntityId')->willReturn(55);

        $conversation = $this->ownedConversation();
        $harness['conversationRepository']->expects(self::once())
            ->method('getById')
            ->with(5)
            ->willReturn($conversation);

        $harness['messageFactory']->method('create')->willReturn($message);
        $harness['messageRepository']->expects(self::once())
            ->method('save')
            ->with(self::identicalTo($message));
        $harness['generatedImageReferences']->expects(self::once())
            ->method('replaceForMessage')
            ->with(55, 'user', 'hello');
        $harness['supportInbox']->expects(self::once())
            ->method('recordCustomerMessage')
            ->with(5);
        $harness['connection']->expects(self::once())->method('beginTransaction');
        $harness['connection']->expects(self::once())->method('commit');
        $harness['connection']->expects(self::never())->method('rollBack');

        self::assertSame(55, $harness['management']->saveMessage(5, 10, 'user', 'hello'));
    }

    public function testSaveMessageRollsBackAndRethrowsWhenTheMessageRowFails(): void
    {
        $harness = $this->createHarness();

        $message = $this->createMock(MessageInterface::class);
        $harness['conversationRepository']->method('getById')->willReturn($this->ownedConversation());
        $harness['messageFactory']->method('create')->willReturn($message);
        $harness['messageRepository']->method('save')
            ->willThrowException(new \RuntimeException('db write failed'));

        $harness['connection']->expects(self::once())->method('beginTransaction');
        $harness['connection']->expects(self::never())->method('commit');
        $harness['connection']->expects(self::once())->method('rollBack');
        $harness['generatedImageReferences']->expects(self::never())->method('replaceForMessage');
        $harness['supportInbox']->expects(self::never())->method('recordCustomerMessage');

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('db write failed');

        $harness['management']->saveMessage(5, 10, 'user', 'hello');
    }

    public function testSaveMessageRollsBackWhenTheSupportInboxUpdateFails(): void
    {
        $harness = $this->createHarness();

        $message = $this->createMock(MessageInterface::class);
        $message->method('getEntityId')->willReturn(55);
        $harness['conversationRepository']->method('getById')->willReturn($this->ownedConversation());
        $harness['messageFactory']->method('create')->willReturn($message);
        $harness['supportInbox']->method('recordCustomerMessage')
            ->willThrowException(new \RuntimeException('inbox update failed'));

        $harness['connection']->expects(self::once())->method('beginTransaction');
        $harness['connection']->expects(self::never())->method('commit');
        $harness['connection']->expects(self::once())->method('rollBack');

        try {
            $harness['management']->saveMessage(5, 10, 'user', 'hello');
            self::fail('A failed inbox update must abort the message save.');
        } catch (\RuntimeException $exception) {
            // The outer handler logs the failure and rethrows so the gateway
            // can retry the whole chain against a rolled-back state.
            self::assertSame('inbox update failed', $exception->getMessage());
        }
    }

    /**
     * Build a ConversationManagement whose write chain dependencies are
     * mocks, with an in-memory connection double for transaction control.
     *
     * @return array<string, mixed>
     */
    private function createHarness(): array
    {
        $connection = $this->createMock(AdapterInterface::class);

        $conversationResource = $this->createMock(ConversationResource::class);
        $conversationResource->method('getConnection')->willReturn($connection);

        $store = $this->createMock(StoreInterface::class);
        $store->method('getId')->willReturn(1);
        $store->method('getWebsiteId')->willReturn(1);
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);

        $logger = $this->createMock(LoggerInterface::class);
        $logger->method('error');

        $deps = [
            'connection' => $connection,
            'conversationRepository' => $this->createMock(ConversationRepositoryInterface::class),
            'conversationFactory' => $this->createMock(ConversationInterfaceFactory::class),
            'messageRepository' => $this->createMock(MessageRepositoryInterface::class),
            'messageFactory' => $this->createMock(MessageInterfaceFactory::class),
            'searchCriteriaBuilder' => $this->createMock(SearchCriteriaBuilder::class),
            'sortOrderBuilder' => $this->createMock(SortOrderBuilder::class),
            'conversationResource' => $conversationResource,
            'supportCaseResource' => $this->createMock(SupportCaseResource::class),
            'messagePageLoader' => $this->createMock(MessagePageLoader::class),
            'chatAttachmentStorage' => $this->createMock(ChatAttachmentStorage::class),
            'nodeRequestAuthorizer' => $this->createMock(NodeRequestAuthorizer::class),
            'supportInbox' => $this->createMock(SupportInboxService::class),
            'storeManager' => $storeManager,
            'generatedImageReferences' => $this->createMock(GeneratedImageReferenceRepository::class),
            'logger' => $logger,
        ];

        $deps['management'] = new ConversationManagement(
            $deps['conversationRepository'],
            $deps['conversationFactory'],
            $deps['messageRepository'],
            $deps['messageFactory'],
            $deps['searchCriteriaBuilder'],
            $deps['sortOrderBuilder'],
            $deps['conversationResource'],
            $deps['supportCaseResource'],
            $deps['messagePageLoader'],
            $deps['chatAttachmentStorage'],
            $deps['nodeRequestAuthorizer'],
            $deps['supportInbox'],
            $deps['storeManager'],
            $deps['generatedImageReferences'],
            $deps['logger']
        );

        return $deps;
    }

    private function ownedConversation(): Conversation
    {
        $conversation = $this->createMock(Conversation::class);
        $conversation->method('getCustomerId')->willReturn(10);
        $conversation->method('getData')->willReturnCallback(
            static fn (string $key) => in_array($key, ['store_id', 'website_id'], true) ? 1 : null
        );

        return $conversation;
    }
}
