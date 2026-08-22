<?php
declare(strict_types=1);

namespace Afd\AI\Ui\DataProvider;

use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Ui\DataProvider\AbstractDataProvider;

class ProviderDataProvider extends AbstractDataProvider
{
    public function __construct(
        string $name,
        string $primaryFieldName,
        string $requestFieldName,
        CollectionFactory $collectionFactory,
        array $meta = [],
        array $data = []
    ) {
        $this->collection = $collectionFactory->create();
        parent::__construct($name, $primaryFieldName, $requestFieldName, $meta, $data);
    }

    public function getData(): array
    {
        $items = [];
        foreach ($this->collection->getItems() as $item) {
            $row = $item->getData();
            // Remove sensitive fields from UI Grid serialization
            unset($row['api_key']);

            $models = $item->getModelsList();
            $modelNames = [];
            foreach ($models as $m) {
                $id = (string)($m['id'] ?? '');
                if ($id !== '') {
                    $modelNames[] = $id;
                }
            }
            $row['models_count'] = count($models);
            $row['models_summary'] = !empty($modelNames) ? implode(', ', $modelNames) : (string)__('No models');
            $items[] = $row;
        }

        return [
            'totalRecords' => $this->collection->getSize(),
            'items' => $items
        ];
    }
}
