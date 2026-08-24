<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Model\ChatMessagePayload;
use Afd\AI\Model\Payload\OrderAddressNormalizer;
use Afd\AI\Model\Payload\ProductPayloadNormalizer;
use Magento\Store\Model\Store;
use Magento\Store\Model\StoreManagerInterface;
use Magento\Framework\UrlInterface;
use Magento\UrlRewrite\Model\UrlFinderInterface;
use PHPUnit\Framework\TestCase;

class ChatMessagePayloadTest extends TestCase
{
    public function testGeneratedImageMustUseMagentoMediaHost(): void
    {
        $store = $this->createMock(Store::class);
        $store->method('getBaseUrl')->with(UrlInterface::URL_TYPE_MEDIA)->willReturn('https://shop.test/media/');
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $storeManager->method('getStore')->willReturn($store);

        $payload = new ChatMessagePayload(
            new ProductPayloadNormalizer(
                $this->createMock(ProductRendererInterface::class),
                $this->createMock(UrlFinderInterface::class),
                $storeManager
            ),
            new OrderAddressNormalizer(),
            $storeManager
        );

        $allowed = $payload->decodeStoredMessage(
            'assistant',
            json_encode([
                'version' => 1,
                'format' => 'afd_ai_chat_message',
                'parts' => [[
                    'type' => 'image',
                    'url' => 'https://shop.test/media/afd-ai/generated/image.png?size=small'
                ]]
            ], JSON_THROW_ON_ERROR),
            'message-1'
        );
        self::assertSame('image', $allowed['parts'][0]['type']);

        $blocked = $payload->decodeStoredMessage(
            'assistant',
            json_encode([
                'version' => 1,
                'format' => 'afd_ai_chat_message',
                'parts' => [[
                    'type' => 'image',
                    'url' => 'https://tracker.example/image.png'
                ]]
            ], JSON_THROW_ON_ERROR),
            'message-2'
        );
        self::assertSame([], $blocked['parts']);
    }

    public function testRelativeGeneratedMediaPathRemainsSupported(): void
    {
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $payload = new ChatMessagePayload(
            new ProductPayloadNormalizer(
                $this->createMock(ProductRendererInterface::class),
                $this->createMock(UrlFinderInterface::class),
                $storeManager
            ),
            new OrderAddressNormalizer(),
            $storeManager
        );

        $decoded = $payload->decodeStoredMessage(
            'assistant',
            json_encode([
                'version' => 1,
                'format' => 'afd_ai_chat_message',
                'parts' => [[
                    'type' => 'image',
                    'url' => '/media/afd-ai/generated/image.webp'
                ]]
            ], JSON_THROW_ON_ERROR),
            'message-3'
        );
        self::assertSame('image', $decoded['parts'][0]['type']);
    }

    public function testProviderReasoningSourceSurvivesAssistantPayloadRoundTrip(): void
    {
        $storeManager = $this->createMock(StoreManagerInterface::class);
        $payload = new ChatMessagePayload(
            new ProductPayloadNormalizer(
                $this->createMock(ProductRendererInterface::class),
                $this->createMock(UrlFinderInterface::class),
                $storeManager
            ),
            new OrderAddressNormalizer(),
            $storeManager
        );

        $encoded = $payload->encodeAssistantParts([[
            'type' => 'reasoning',
            'events' => [[
                'id' => 'provider-reasoning-reasoning-1',
                'type' => 'step',
                'source' => 'provider_reasoning',
                'content' => '**Analyzing** the request.'
            ]]
        ]]);
        $decoded = $payload->decodeStoredMessage('assistant', $encoded, 'message-4');

        self::assertSame('provider_reasoning', $decoded['parts'][0]['events'][0]['source']);
        self::assertSame('**Analyzing** the request.', $decoded['parts'][0]['events'][0]['content']);
    }
}
