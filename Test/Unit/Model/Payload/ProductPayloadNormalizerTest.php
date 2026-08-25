<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Payload;

use Afd\AI\Api\ProductRendererInterface;
use Afd\AI\Model\Payload\ProductPayloadNormalizer;
use Magento\Store\Model\StoreManagerInterface;
use Magento\UrlRewrite\Model\UrlFinderInterface;
use PHPUnit\Framework\TestCase;

class ProductPayloadNormalizerTest extends TestCase
{
    public function testProductsPartBeforeTextKeepsItsOriginalPosition(): void
    {
        $parts = [
            $this->productsPart('<div>grid-a</div>', $this->payload([11], 'shoe')),
            ['type' => 'text', 'raw' => 'Here is what I found.'],
        ];

        $merged = $this->normalizer()->mergeSequentialProductParts($parts);

        self::assertCount(2, $merged);
        self::assertSame('products', $merged[0]['type']);
        self::assertSame(11, (int)$merged[0]['payload']['product_ids'][0]);
        self::assertSame('text', $merged[1]['type']);
        self::assertSame('Here is what I found.', $merged[1]['raw']);
    }

    public function testTextPartBeforeProductsKeepsItsOriginalPosition(): void
    {
        $parts = [
            ['type' => 'text', 'raw' => 'Let me check the catalogue.'],
            $this->productsPart('<div>grid-a</div>', $this->payload([12], 'shoe')),
        ];

        $merged = $this->normalizer()->mergeSequentialProductParts($parts);

        self::assertCount(2, $merged);
        self::assertSame('text', $merged[0]['type']);
        self::assertSame('Let me check the catalogue.', $merged[0]['raw']);
        self::assertSame('products', $merged[1]['type']);
        self::assertSame(12, (int)$merged[1]['payload']['product_ids'][0]);
    }

    public function testTwoIndependentProductGridsAreBothKeptInOrder(): void
    {
        $parts = [
            $this->productsPart('<div>grid-a</div>', $this->payload([21], 'shoe')),
            ['type' => 'text', 'raw' => 'And a second option set:'],
            $this->productsPart('<div>grid-b</div>', $this->payload([22], 'boot')),
        ];

        $merged = $this->normalizer()->mergeSequentialProductParts($parts);

        self::assertCount(3, $merged);
        self::assertSame('products', $merged[0]['type']);
        self::assertSame(21, (int)$merged[0]['payload']['product_ids'][0]);
        self::assertSame('text', $merged[1]['type']);
        self::assertSame('products', $merged[2]['type']);
        self::assertSame(22, (int)$merged[2]['payload']['product_ids'][0]);
    }

    public function testPaginatedContinuationIsMergedIntoASingleGrid(): void
    {
        $pageOne = $this->payload([31], 'shoe', 1, true);
        $pageTwo = $this->payload([32], 'shoe', 2, false);
        $parts = [
            $this->productsPart('<div>grid-a</div>', $pageOne),
            $this->productsPart('<div>grid-b</div>', $pageTwo),
        ];

        $merged = $this->normalizer()->mergeSequentialProductParts($parts);

        self::assertCount(1, $merged);
        self::assertSame('products', $merged[0]['type']);
        self::assertSame([31, 32], array_map('intval', $merged[0]['payload']['product_ids']));
        self::assertSame(2, (int)$merged[0]['payload']['pagination']['page']);
        self::assertFalse((bool)$merged[0]['payload']['pagination']['has_more']);
    }

    public function testContinuationAfterInterveningTextStaysBeforeThatText(): void
    {
        $pageOne = $this->payload([41], 'shoe', 1, true);
        $pageTwo = $this->payload([42], 'shoe', 2, false);
        $parts = [
            $this->productsPart('<div>grid-a</div>', $pageOne),
            ['type' => 'text', 'raw' => 'More results followed.'],
            $this->productsPart('<div>grid-b</div>', $pageTwo),
        ];

        $merged = $this->normalizer()->mergeSequentialProductParts($parts);

        self::assertCount(2, $merged);
        self::assertSame('products', $merged[0]['type']);
        self::assertSame([41, 42], array_map('intval', $merged[0]['payload']['product_ids']));
        self::assertSame('text', $merged[1]['type']);
        self::assertSame('More results followed.', $merged[1]['raw']);
    }

    private function normalizer(): ProductPayloadNormalizer
    {
        $productRenderer = $this->createMock(ProductRendererInterface::class);
        $productRenderer->method('renderProducts')->willReturn('');

        return new ProductPayloadNormalizer(
            $productRenderer,
            $this->createMock(UrlFinderInterface::class),
            $this->createMock(StoreManagerInterface::class)
        );
    }

    /**
     * @param int[] $productIds
     */
    private function productsPart(string $html, array $payload): array
    {
        return [
            'id' => 'message-1',
            'type' => 'products',
            'html' => $html,
            'payload' => $payload,
        ];
    }

    /**
     * @param int[] $productIds
     * @return array<string, mixed>
     */
    private function payload(array $productIds, string $query, int $page = 1, bool $hasMore = false): array
    {
        $items = [];
        foreach ($productIds as $productId) {
            $items[] = [
                'id' => $productId,
                'sku' => 'SKU-' . $productId,
                'name' => 'Test product ' . $productId,
                'price' => '9,90 €',
                'url' => 'https://shop.test/product-' . $productId . '.html',
                'in_stock' => '',
                'product_type' => 'simple',
                'requires_variant_selection' => false,
                'variant_options' => [],
            ];
        }

        return [
            'contract_version' => 2,
            'kind' => 'product_list',
            'query' => $query,
            'product_ids' => $productIds,
            'items' => $items,
            'total' => count($productIds) + ($hasMore ? 1 : 0),
            'pagination' => [
                'page' => $page,
                'page_size' => count($productIds),
                'total' => count($productIds) + ($hasMore ? 1 : 0),
                'returned' => count($productIds),
                'has_more' => $hasMore,
                'next_page' => $hasMore ? $page + 1 : null,
                'can_load_more' => $hasMore,
                'chat_card_limit' => 20,
                'truncated_for_chat' => false,
            ],
        ];
    }
}
