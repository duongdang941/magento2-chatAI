<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Framework\Data\OptionSourceInterface;

class AiModel implements OptionSourceInterface
{
    public function __construct(
        private readonly CollectionFactory $collectionFactory
    ) {}

    public function toOptionArray(): array
    {
        $options = [];
        $collection = $this->collectionFactory->create();
        $collection->addFieldToFilter('is_active', 1);
        $collection->setOrder('name', 'ASC');

        foreach ($collection as $provider) {
            $models = $provider->getModelsList();
            if (empty($models)) {
                continue;
            }

            foreach ($models as $m) {
                $mId = (string)($m['id'] ?? '');
                if ($mId === '') continue;
                $options[] = [
                    'value' => $mId,
                    'label' => $mId
                ];
            }
        }

        if (empty($options)) {
            $options[] = [
                'value' => '',
                'label' => __('-- No Models Available --')
            ];
        }

        return $options;
    }
}
