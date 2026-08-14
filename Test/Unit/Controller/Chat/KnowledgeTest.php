<?php
declare(strict_types=1);

namespace Afd\AI\Test\Unit\Controller\Chat;

use Afd\AI\Controller\Chat\Knowledge;
use Afd\AI\Model\Knowledge\StoreKnowledgeSearch;
use Afd\AI\Model\Security\NodeRequestAuthorizer;
use Afd\AI\Model\Store\InternalStoreContext;
use Magento\Framework\App\Request\Http;
use Magento\Framework\Controller\Result\Json;
use Magento\Framework\Controller\ResultFactory;
use PHPUnit\Framework\TestCase;

class KnowledgeTest extends TestCase
{
    public function testUsesCustomerGroupOnlyFromTheSignedNodePayload(): void
    {
        $request = $this->getMockBuilder(Http::class)->disableOriginalConstructor()->onlyMethods(['getContent'])->getMock();
        $request->method('getContent')->willReturn(json_encode([
            'storeCode' => 'de',
            'query' => 'return policy',
            'limit' => 4,
            'customerGroupId' => 7,
        ], JSON_THROW_ON_ERROR));
        $authorizer = $this->createMock(NodeRequestAuthorizer::class);
        $authorizer->expects(self::once())->method('assertAuthorized');
        $search = $this->createMock(StoreKnowledgeSearch::class);
        $search->expects(self::once())->method('search')->with('return policy', 4, 7)->willReturn([
            'status' => 'success', 'results' => [],
        ]);
        $scope = $this->createMock(InternalStoreContext::class);
        $scope->expects(self::once())->method('execute')->with('de', self::isType('callable'))
            ->willReturnCallback(static fn (string $storeCode, callable $operation): array => $operation());
        $result = $this->createMock(Json::class);
        $result->expects(self::once())->method('setData')->with(['status' => 'success', 'results' => []])->willReturnSelf();
        $factory = $this->createMock(ResultFactory::class);
        $factory->method('create')->with(ResultFactory::TYPE_JSON)->willReturn($result);

        $controller = new Knowledge($request, $factory, $authorizer, $search, $scope);
        self::assertSame($result, $controller->execute());
    }
}
