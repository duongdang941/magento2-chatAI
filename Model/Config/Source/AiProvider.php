<?php
declare(strict_types=1);

namespace Afd\AI\Model\Config\Source;

use Afd\AI\Model\ResourceModel\Provider\CollectionFactory;
use Magento\Framework\Data\OptionSourceInterface;

class AiProvider implements OptionSourceInterface
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

        if ($collection->count() === 0) {
            $options[] = [
                'value' => '',
                'label' => __('-- No Providers Configured --')
            ];
            return $options;
        }

        foreach ($collection as $provider) {
            $options[] = [
                'value' => (string)$provider->getProviderCode(),
                'label' => (string)$provider->getName()
            ];
        }

        return $options;
    }
}
