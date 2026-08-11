<?php
declare(strict_types=1);

namespace Afd\AI\Ui\Component\Listing\Column;

use Magento\Framework\UrlInterface;
use Magento\Ui\Component\Listing\Columns\Column;

class SupportCaseActions extends Column
{
    public function __construct(
        \Magento\Framework\View\Element\UiComponent\ContextInterface $context,
        \Magento\Framework\View\Element\UiComponentFactory $uiComponentFactory,
        private readonly UrlInterface $urlBuilder,
        array $components = [],
        array $data = []
    ) {
        parent::__construct($context, $uiComponentFactory, $components, $data);
    }

    public function prepareDataSource(array $dataSource): array
    {
        if (isset($dataSource['data']['items'])) {
            foreach ($dataSource['data']['items'] as &$item) {
                if (!empty($item['entity_id'])) {
                    $item[$this->getData('name')]['view'] = [
                        'href' => $this->urlBuilder->getUrl(
                            'afd_ai/supportcase/view',
                            ['entity_id' => (int)$item['entity_id']]
                        ),
                        'label' => __('Open chat'),
                        'ariaLabel' => __('Open support chat'),
                        'hidden' => false,
                    ];
                }
            }
            unset($item);
        }

        return $dataSource;
    }
}
