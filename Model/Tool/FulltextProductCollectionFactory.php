<?php
declare(strict_types=1);

namespace Afd\AI\Model\Tool;

use Magento\CatalogSearch\Model\ResourceModel\Fulltext\Collection as FulltextCollection;
use Magento\Framework\ObjectManagerInterface;
use Magento\Framework\Search\EngineResolverInterface;

/**
 * Creates the catalogue-search collection for the selected Magento engine.
 *
 * Magento's generated product collection factory defaults to the base EAV
 * collection, which does not implement addSearchFilter(). The engine-specific
 * virtual type is equally important: Elasticsearch injects its search request
 * resolver there. Instantiating the base FulltextCollection directly skips
 * that configuration and can generate an invalid Elasticsearch sort request.
 */
class FulltextProductCollectionFactory
{
    private ObjectManagerInterface $objectManager;
    private EngineResolverInterface $engineResolver;
    private array $collectionTypes;

    public function __construct(
        ObjectManagerInterface $objectManager,
        EngineResolverInterface $engineResolver,
        array $collectionTypes = []
    ) {
        $this->objectManager = $objectManager;
        $this->engineResolver = $engineResolver;
        $this->collectionTypes = $collectionTypes;
    }

    public function create(array $data = []): FulltextCollection
    {
        $engine = $this->engineResolver->getCurrentSearchEngine();
        $collectionType = $this->collectionTypes[$engine] ?? FulltextCollection::class;

        return $this->objectManager->create($collectionType, $data);
    }
}
