<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Model\Maintenance;

use Afd\AI\Model\Maintenance\GeneratedImageReferenceRepository;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use PHPUnit\Framework\TestCase;

class GeneratedImageReferenceRepositoryTest extends TestCase
{
    public function testIndexesOnlyUniqueGeneratedImageFilenames(): void
    {
        $connection = $this->createMock(AdapterInterface::class);
        $connection->expects(self::once())
            ->method('delete')
            ->with('afd_ai_generated_image_reference', ['message_id = ?' => 42]);

        $rows = [];
        $connection->expects(self::exactly(2))
            ->method('insert')
            ->willReturnCallback(static function (string $table, array $row) use (&$rows): int {
                self::assertSame('afd_ai_generated_image_reference', $table);
                $rows[] = $row;
                return 1;
            });

        $resource = $this->createMock(ResourceConnection::class);
        $resource->method('getConnection')->willReturn($connection);
        $resource->method('getTableName')->with('afd_ai_generated_image_reference')
            ->willReturn('afd_ai_generated_image_reference');

        $content = json_encode([
            'parts' => [
                ['type' => 'text', 'raw' => 'Here are the images'],
                ['type' => 'image', 'url' => 'https://shop.example/media/afd-ai/generated/first.png'],
                ['type' => 'image', 'url' => '/media/afd-ai/generated/second.webp?version=1'],
                ['type' => 'image', 'url' => 'https://shop.example/media/afd-ai/generated/first.png'],
                ['type' => 'image', 'url' => 'https://cdn.example/other.png'],
            ],
        ], JSON_THROW_ON_ERROR);

        (new GeneratedImageReferenceRepository($resource))->replaceForMessage(42, 'assistant', $content);

        self::assertSame(['first.png', 'second.webp'], array_column($rows, 'filename'));
        self::assertSame([42, 42], array_column($rows, 'message_id'));
    }
}
